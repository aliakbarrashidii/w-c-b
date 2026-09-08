const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const CallLog = require('../models/CallLog');
const Session = require('../models/Session');
const { encryptText, decryptText } = require('../utils/crypto');
const { sendPushNotifications } = require('../utils/push');

const onlineUsers = new Map(); // userId -> Set(socketId)

function addOnline(userId, socketId) {
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socketId);
}
function removeOnline(userId, socketId) {
  const set = onlineUsers.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) onlineUsers.delete(userId);
}
function isOnline(userId) {
  return onlineUsers.has(userId.toString());
}

module.exports = function initSocket(io) {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('توکن ارسال نشده است'));
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(payload.id);
      if (!user || user.status === 'banned') return next(new Error('دسترسی غیرمجاز'));
      if (payload.sid) {
        const session = await Session.findById(payload.sid);
        if (!session || session.revoked) return next(new Error('این نشست از راه دور خارج شده است'));
      }
      socket.userId = user._id.toString();
      socket.user = user;
      next();
    } catch (err) {
      next(new Error('توکن نامعتبر است'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.userId;
    addOnline(userId, socket.id);

    await User.findByIdAndUpdate(userId, { isOnline: true });
    socket.broadcast.emit('presence:update', { userId, isOnline: true });

    // عضویت در روم تک‌تک چت‌های کاربر برای دریافت پیام‌های لحظه‌ای
    const chats = await Chat.find({ 'members.user': userId }).select('_id');
    chats.forEach((c) => socket.join(`chat:${c._id}`));

    // پیام‌هایی که وقتی کاربر آفلاین بوده براش اومده، همین لحظه که وصل شد delivered می‌شن
    for (const c of chats) {
      const pending = await Message.find({
        chat: c._id,
        sender: { $ne: userId },
        'deliveredTo.user': { $ne: userId },
        deletedForEveryone: { $ne: true },
      }).select('_id chat');
      if (pending.length) {
        await Message.updateMany(
          { _id: { $in: pending.map((m) => m._id) } },
          { $addToSet: { deliveredTo: { user: userId, deliveredAt: new Date() } } }
        );
        io.to(`chat:${c._id}`).emit('message:delivered', {
          chatId: c._id,
          messageIds: pending.map((m) => m._id),
          toUserIds: [userId],
        });
      }
    }

    // --- پیام‌رسانی ---
    socket.on('message:send', async (data, ack) => {
      try {
        const { chatId, type = 'text', content = '', mediaUrl = '', mediaMeta = {}, replyTo = null, clientId = null } = data;
        const chat = await Chat.findById(chatId);
        if (!chat) return ack?.({ error: 'چت یافت نشد' });
        const isMember = chat.members.some((m) => m.user.toString() === userId);
        if (!isMember) return ack?.({ error: 'شما عضو این چت نیستید' });

        // جلوگیری از پیام تکراری: اگر همین clientId قبلاً از همین فرستنده ثبت شده، همون رو برگردون
        // (مثلاً وقتی سوکت لحظه‌ای قطع/وصل شده و کلاینت دوباره تلاش کرده)
        if (clientId) {
          const existing = await Message.findOne({ chat: chatId, sender: userId, clientId });
          if (existing) {
            await existing.populate('sender', 'username displayName avatarUrl');
            const dup = existing.toObject();
            dup.content = decryptText(dup.content);
            return ack?.({ ok: true, message: dup, duplicate: true });
          }
        }

        const onlineMemberIds = chat.members
          .filter((m) => m.user.toString() !== userId && isOnline(m.user.toString()))
          .map((m) => m.user);

        const message = await Message.create({
          chat: chatId,
          sender: userId,
          clientId,
          type,
          content: encryptText(content),
          mediaUrl,
          mediaMeta,
          replyTo,
          deliveredTo: onlineMemberIds.map((u) => ({ user: u })), // گیرنده‌های آنلاین همون لحظه delivered حساب می‌شن
        });
        await message.populate('sender', 'username displayName avatarUrl');

        chat.lastMessage = message._id;
        chat.lastActivityAt = new Date();
        await chat.save();

        // نسخه‌ی رمزگشایی‌شده فقط برای پخش لحظه‌ای بین اعضای همین چت (نه ذخیره‌سازی)
        const outgoing = message.toObject();
        outgoing.content = content;

        io.to(`chat:${chatId}`).emit('message:new', outgoing);
        ack?.({ ok: true, message: outgoing });

        if (onlineMemberIds.length) {
          socket.to(`chat:${chatId}`).emit('message:delivered', { chatId, messageIds: [message._id], toUserIds: onlineMemberIds });
        }

        // نوتیفیکیشن پوش برای اعضایی که الان روی سوکت آنلاین نیستند (هرکس طبق تنظیمات خودش)
        const offlineMembers = chat.members.filter((m) => m.user.toString() !== userId && !isOnline(m.user.toString()));
        if (offlineMembers.length) {
          const recipientUsers = await User.find({ _id: { $in: offlineMembers.map((m) => m.user) } }).select(
            'pushTokens notificationSettings'
          );
          const previewText = type === 'text' ? content : type === 'image' ? '📷 عکس' : type === 'voice' ? '🎤 پیام صوتی' : 'فایل جدید';
          for (const recipient of recipientUsers) {
            const settings = recipient.notificationSettings || {};
            if (settings.enabled === false) continue; // این کاربر نوتیفیکیشن پیام رو غیرفعال کرده
            sendPushNotifications(recipient.pushTokens, {
              title: socket.user.displayName,
              body: settings.preview === false ? 'پیام جدید' : previewText.slice(0, 120),
              sound: settings.sound === false ? null : 'default',
              data: { chatId, type: 'message' },
            });
          }
        }
      } catch (err) {
        ack?.({ error: 'ارسال پیام ناموفق بود' });
      }
    });

    socket.on('message:edit', async ({ messageId, content }) => {
      const message = await Message.findById(messageId);
      if (!message || message.sender.toString() !== userId) return;
      message.content = encryptText(content);
      message.editedAt = new Date();
      await message.save();
      io.to(`chat:${message.chat}`).emit('message:edited', { messageId, content, editedAt: message.editedAt });
    });

    socket.on('message:delete', async ({ messageId, forEveryone }) => {
      const message = await Message.findById(messageId);
      if (!message) return;
      const isSender = message.sender.toString() === userId;
      if (forEveryone) {
        if (!isSender) return; // فقط فرستنده می‌تونه برای همه حذف کنه
        message.deletedForEveryone = true;
        message.content = '';
        await message.save();
        io.to(`chat:${message.chat}`).emit('message:deleted', { messageId, forEveryone: true });
      } else {
        // حذف فقط برای خودم — هر عضو چت می‌تونه این کارو با هر پیامی بکنه
        if (!message.deletedFor.some((id) => id.toString() === userId)) {
          message.deletedFor.push(userId);
          await message.save();
        }
        socket.emit('message:deleted', { messageId, forEveryone: false });
      }
    });

    // فوروارد یک پیام به یک یا چند چت دیگر (شامل «پیام‌های ذخیره‌شده»)
    socket.on('message:forward', async ({ messageId, toChatIds = [] }, ack) => {
      try {
        const original = await Message.findById(messageId);
        if (!original) return ack?.({ error: 'پیام یافت نشد' });

        const results = [];
        for (const targetChatId of toChatIds) {
          const chat = await Chat.findById(targetChatId);
          if (!chat) continue;
          const isMember = chat.members.some((m) => m.user.toString() === userId);
          if (!isMember) continue;

          const forwarded = await Message.create({
            chat: targetChatId,
            sender: userId,
            type: original.type,
            content: original.content, // از قبل رمزنگاری‌شده روی دیتابیس است، مستقیم کپی می‌شود
            mediaUrl: original.mediaUrl,
            mediaMeta: original.mediaMeta,
            forwardedFrom: { originalSender: original.sender, originalChat: original.chat },
          });
          await forwarded.populate('sender', 'username displayName avatarUrl');

          chat.lastMessage = forwarded._id;
          chat.lastActivityAt = new Date();
          await chat.save();

          const outgoing = forwarded.toObject();
          outgoing.content = decryptText(outgoing.content);
          io.to(`chat:${targetChatId}`).emit('message:new', outgoing);
          results.push(outgoing);
        }
        ack?.({ ok: true, forwarded: results });
      } catch (err) {
        ack?.({ error: 'فوروارد ناموفق بود' });
      }
    });

    // افزودن/حذف ری‌اکشن روی یک پیام
    socket.on('message:react', async ({ messageId, emoji }) => {
      const message = await Message.findById(messageId);
      if (!message) return;
      const existingIndex = message.reactions.findIndex((r) => r.user.toString() === userId);
      if (existingIndex >= 0 && message.reactions[existingIndex].emoji === emoji) {
        message.reactions.splice(existingIndex, 1); // زدن دوباره همان ایموجی = حذف ری‌اکشن
      } else if (existingIndex >= 0) {
        message.reactions[existingIndex].emoji = emoji;
      } else {
        message.reactions.push({ user: userId, emoji });
      }
      await message.save();
      io.to(`chat:${message.chat}`).emit('message:reacted', { messageId, reactions: message.reactions });
    });

    socket.on('message:read', async ({ chatId, messageId }) => {
      await Message.findByIdAndUpdate(messageId, {
        $addToSet: { readBy: { user: userId, readAt: new Date() } },
      });
      socket.to(`chat:${chatId}`).emit('message:read', { chatId, messageId, userId });
    });

    socket.on('typing:start', ({ chatId }) => {
      socket.to(`chat:${chatId}`).emit('typing:start', { chatId, userId });
    });
    socket.on('typing:stop', ({ chatId }) => {
      socket.to(`chat:${chatId}`).emit('typing:stop', { chatId, userId });
    });

    socket.on('chat:join', ({ chatId }) => socket.join(`chat:${chatId}`));

    // --- تماس صوتی/تصویری (سیگنالینگ WebRTC) ---
    socket.on('call:invite', async ({ chatId, calleeId, kind }) => {
      const callLog = await CallLog.create({ chat: chatId, caller: userId, callee: calleeId, kind, status: 'ringing' });
      const targetSockets = onlineUsers.get(calleeId.toString());
      if (targetSockets) {
        targetSockets.forEach((sid) =>
          io.to(sid).emit('call:incoming', {
            callId: callLog._id,
            chatId,
            kind,
            from: { id: userId, displayName: socket.user.displayName, avatarUrl: socket.user.avatarUrl },
          })
        );
      } else {
        const callee = await User.findById(calleeId).select('pushTokens');
        sendPushNotifications(callee?.pushTokens || [], {
          title: socket.user.displayName,
          body: kind === 'video' ? 'تماس تصویری ورودی' : 'تماس صوتی ورودی',
          data: { chatId, type: 'call', callId: callLog._id.toString(), kind, callerId: userId },
        });
      }
      socket.emit('call:ringing', { callId: callLog._id });
    });

    socket.on('call:accept', async ({ callId, callerId }) => {
      await CallLog.findByIdAndUpdate(callId, { status: 'accepted' });
      const targetSockets = onlineUsers.get(callerId.toString());
      targetSockets?.forEach((sid) => io.to(sid).emit('call:accepted', { callId }));
    });

    socket.on('call:decline', async ({ callId, callerId }) => {
      await CallLog.findByIdAndUpdate(callId, { status: 'declined', endedAt: new Date() });
      const targetSockets = onlineUsers.get(callerId.toString());
      targetSockets?.forEach((sid) => io.to(sid).emit('call:declined', { callId }));
    });

    socket.on('call:end', async ({ callId, peerId, durationSec }) => {
      await CallLog.findByIdAndUpdate(callId, { status: 'ended', endedAt: new Date(), durationSec: durationSec || 0 });
      const targetSockets = onlineUsers.get(peerId?.toString());
      targetSockets?.forEach((sid) => io.to(sid).emit('call:ended', { callId }));
    });

    // رد و بدل کردن SDP offer/answer و ICE candidates بین دو طرف تماس
    socket.on('call:signal', ({ toUserId, signal }) => {
      const targetSockets = onlineUsers.get(toUserId.toString());
      targetSockets?.forEach((sid) => io.to(sid).emit('call:signal', { fromUserId: userId, signal }));
    });

    socket.on('disconnect', async () => {
      removeOnline(userId, socket.id);
      if (!isOnline(userId)) {
        await User.findByIdAndUpdate(userId, { isOnline: false, lastSeen: new Date() });
        socket.broadcast.emit('presence:update', { userId, isOnline: false, lastSeen: new Date() });
      }
    });
  });
};
