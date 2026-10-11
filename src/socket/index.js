const { guard: restrictionGuard, MEDIA_FEATURE } = require('../utils/restrictions');
const chatRights = require('../utils/chatRights');
const botEngine = require('../utils/botEngine');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Chat = require('../models/Chat');
const { unpinMessages } = require('../utils/dataCleanup');
const { anonymizeChannelSender } = require('../utils/channelPrivacy');
const { verifyAccessToken, isTokenCurrent } = require('../utils/tokens');
const Message = require('../models/Message');
const CallLog = require('../models/CallLog');
const Session = require('../models/Session');
const Activity = require('../models/Activity');
const { encryptText, decryptText } = require('../utils/crypto');
const { scanContent } = require('../utils/contentFilter');
const { sendPushNotifications } = require('../utils/push');
const { markFullyDelivered } = require('../utils/messageDelivery');
const { startRetentionScheduler } = require('../utils/messageRetentionJob');
const { getSettings } = require('../utils/settings');
const SenderKeyDistribution = require('../models/SenderKeyDistribution');
const ScheduledMessage = require('../models/ScheduledMessage');

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
      const payload = verifyAccessToken(token);
      const user = await User.findById(payload.id);
      if (!user || user.status === 'banned' || user.status === 'deleted' || !isTokenCurrent(payload, user)) return next(new Error('دسترسی غیرمجاز'));
      if (payload.sid) {
        const session = await Session.findById(payload.sid);
        if (!session || session.revoked) return next(new Error('این نشست از راه دور خارج شده است'));
      }
      // حالت تعمیر: فقط ادمین/مدیر می‌تونن وصل بشن؛ بقیه صفحه‌ی «در حال بروزرسانی» رو می‌بینن
      // (کلاینت این رو از GET /api/settings/public هم قبل از اتصال چک می‌کنه)
      const settings = await getSettings();
      if (settings.maintenanceMode?.enabled && user.role !== 'admin' && user.role !== 'moderator') {
        return next(new Error('MAINTENANCE_MODE'));
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

    // عضویت کاربر در یک چت (برای هندلرهایی که فقط messageId می‌گیرن - بدون این چک، هر کاربری با دونستن ObjectId می‌تونست روی
    // پیامِ چت‌های دیگه کار کنه: فوروارد/ریپلای = خوندن محتوا، ری‌اکشن/ریویل = دستکاری)
    const isMemberOf = async (chatId) => !!(chatId && (await Chat.exists({ _id: chatId, 'members.user': userId })));
    addOnline(userId, socket.id);

    await User.findByIdAndUpdate(userId, { isOnline: true });
    socket.broadcast.emit('presence:update', { userId, isOnline: true });

    // عضویت در روم تک‌تک چت‌های کاربر برای دریافت پیام‌های لحظه‌ای
    const chats = await Chat.find({ 'members.user': userId }).select('_id members');
    chats.forEach((c) => socket.join(`chat:${c._id}`));
    // روم شخصیِ خودِ کاربر - برای رویدادهایی مثل تغییر عضویت گروه که ممکنه چتش باز نباشه
    socket.join(`user:${userId}`);

    // توزیع‌های سندرکیِ گروهی که وقتی کاربر آفلاین بوده براش صف شدن، همین لحظه که وصل شد می‌رسن
    const pendingDistributions = await SenderKeyDistribution.find({ toUser: userId });
    pendingDistributions.forEach((d) => {
      socket.emit('senderkey:distribution', { id: d._id, groupId: d.groupId, fromUserId: d.fromUser, e2e: d.e2e });
    });

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
        await markFullyDelivered(c, pending.map((m) => m._id));
      }
    }

    // --- پیام‌رسانی ---
    socket.on('message:send', async (data, ack) => {
      try {
        const { chatId, type = 'text', content = '', mediaUrl = '', mediaMeta = {}, replyTo: rawReplyTo = null, clientId = null, e2e = null, groupE2e = null, scheduledFor = null, viewOnceDurationSec = null, silent = false, topicId = null } = data;
        // ریپلای فقط به پیامِ «همین چت» مجازه؛ وگرنه GET پیام‌ها محتوای رمزگشایی‌شده‌ی پیامِ چت دیگه رو برمی‌گردوند (IDOR)
        let replyTo = null;
        if (rawReplyTo) {
          try { replyTo = (await Message.exists({ _id: rawReplyTo, chat: chatId })) ? rawReplyTo : null; } catch { replyTo = null; }
        }
        const chat = await Chat.findById(chatId);
        if (!chat) return ack?.({ error: 'چت یافت نشد' });
        const isMember = chat.members.some((m) => m.user.toString() === userId);
        if (!isMember) return ack?.({ error: 'شما عضو این چت نیستید' });

        // محدودیت‌های اعمال‌شده از پنل ادمین (به‌ازای هر نوع پیام جدا)
        const restricted = await restrictionGuard(userId, MEDIA_FEATURE[type] || 'send_media');
        if (restricted) return ack?.({ error: restricted, restricted: true });

        // مجوزهای گروه/کانال برای اعضای عادی + سکوت موقتِ فردی (ادمین/مالک مستثنی)
        if (['group', 'channel'].includes(chat.type)) {
          const permFor = { text: 'sendMessages', sticker: 'sendStickers', poll: 'sendPolls', location: 'sendPolls', contact: 'sendPolls' }[type] || 'sendMedia';
          if (!chatRights.memberAllowed(chat, userId, permFor)) {
            const until = chatRights.restrictionRemaining(chat, userId);
            return ack?.({ error: until ? 'مدیر گروه ارسال پیام از طرف تو رو موقتاً محدود کرده' : 'مدیر گروه این نوع پیام رو برای اعضا بسته', restricted: true });
          }
        }

        // حالت آهسته: عضو عادی بین دو پیام باید صبر کنه (ادمین/مالک مستثنی)
        if (chat.type === 'group' && chat.slowModeSec > 0) {
          const mine = chat.members.find((m) => m.user.toString() === userId);
          if (mine?.role === 'member') {
            const last = await Message.findOne({ chat: chatId, sender: userId }).sort({ createdAt: -1 }).select('createdAt');
            const wait = last ? Math.ceil((chat.slowModeSec * 1000 - (Date.now() - last.createdAt.getTime())) / 1000) : 0;
            if (wait > 0) return ack?.({ error: `حالت آهسته فعاله؛ ${wait} ثانیه‌ی دیگه می‌تونی پیام بدی`, slowMode: true });
          }
        }

        // تو کانال فقط owner/admin می‌تونن پیام بفرستن، بقیه فقط می‌خونن
        if (chat.type === 'channel') {
          const myRole = chat.members.find((m) => m.user.toString() === userId)?.role;
          if (myRole !== 'owner' && myRole !== 'admin') {
            return ack?.({ error: 'فقط ادمین‌های کانال می‌توانند پیام ارسال کنند' });
          }
        }

        // پیام زمان‌دار: عضویت/دسترسی همین الان چک شد (بالا)؛ خودِ ساخت و پخشِ پیام موقع فرارسیدنِ
        // زمان، توسط scheduledMessageJob انجام می‌شه - نه اینجا. زمان رو با ساعتِ خودِ سرور می‌سنجیم.
        if (scheduledFor && new Date(scheduledFor) > new Date()) {
          const scheduled = await ScheduledMessage.create({
            chat: chatId, sender: userId, clientId, type, content, e2e, groupE2e, mediaUrl, mediaMeta, replyTo,
            scheduledFor: new Date(scheduledFor),
          });
          return ack?.({ ok: true, scheduled: true, scheduledId: scheduled._id, scheduledFor: scheduled.scheduledFor });
        }

        // جلوگیری از پیام تکراری: اگر همین clientId قبلاً از همین فرستنده ثبت شده، همون رو برگردون
        // (مثلاً وقتی سوکت لحظه‌ای قطع/وصل شده و کلاینت دوباره تلاش کرده)
        if (clientId) {
          const existing = await Message.findOne({ chat: chatId, sender: userId, clientId });
          if (existing) {
            await existing.populate('sender', 'username displayName avatarUrl isBot');
            const dup = existing.toObject();
            if (!dup.e2e?.senderDeviceId && !dup.groupE2e?.ciphertext) dup.content = decryptText(dup.content);
            return ack?.({ ok: true, message: dup, duplicate: true });
          }
        }

        const onlineMemberIds = chat.members
          .filter((m) => m.user.toString() !== userId && isOnline(m.user.toString()))
          .map((m) => m.user);

        // تشخیص @mention در گروه‌ها (بدون populate کردن خودِ chat، که قراره save هم بشه)
        let mentionedUserIds = [];
        if (type === 'text' && chat.type === 'group' && content.includes('@')) {
          const memberUsers = await User.find({ _id: { $in: chat.members.map((m) => m.user) } }).select('username');
          const usernameToId = {};
          memberUsers.forEach((u) => { usernameToId[u.username.toLowerCase()] = u._id.toString(); });
          const matches = content.match(/@([a-zA-Z0-9_]+)/g) || [];
          const idsSet = new Set();
          matches.forEach((m) => {
            const uid = usernameToId[m.slice(1).toLowerCase()];
            if (uid && uid !== userId) idsSet.add(uid);
          });
          mentionedUserIds = Array.from(idsSet);
        }

        const message = await Message.create({
          chat: chatId,
          sender: userId,
          clientId,
          type,
          // چت خصوصی/مخفیِ رمزنگاری‌شده با X3DH+Double Ratchet: content همیشه خالیه، سرور نمی‌تونه بازش کنه.
          // گروهِ رمزشده با Sender Key هم همین‌طور. بقیه‌ی چت مخفی (حالت قدیمی‌تر بدون e2e) و چت‌های
          // عادی/گروهِ بدون E2E طبق روال قبل.
          content: e2e || groupE2e ? '' : chat.type === 'secret' ? content : encryptText(content),
          e2e: e2e || undefined,
          groupE2e: groupE2e || undefined,
          mediaUrl,
          mediaMeta,
          replyTo,
          // تاپیکِ گروه: فقط اگه شناسه واقعاً مال همین گروهه (وگرنه پیام «عمومی» می‌شه)
          topic: chat.type === 'group' && topicId && chat.topics?.some((t) => String(t._id) === String(topicId)) ? topicId : undefined,
          viewOnceDurationSec: viewOnceDurationSec > 0 ? viewOnceDurationSec : undefined,
          mentions: mentionedUserIds,
          deliveredTo: onlineMemberIds.map((u) => ({ user: u })), // گیرنده‌های آنلاین همون لحظه delivered حساب می‌شن
        });
        await message.populate('sender', 'username displayName avatarUrl isBot');

        // فیلتر حداقلی کلیدواژه‌ای (نه هوش مصنوعی واقعی) — فقط برای فلگ کردن اولیه برای بررسی ادمین
        // (چت‌های e2e/مخفی رو اصلاً چک نمی‌کنیم چون سرور محتواشون رو اصلاً نمی‌بینه؛ فیلتر واقعی محتوای
        // این چت‌ها رو مدل روی خودِ گوشی انجام می‌ده و فقط گزارشِ رمزشده می‌فرسته - فاز بعدی)
        if (type === 'text' && chat.type !== 'secret' && !e2e && !groupE2e) {
          const flagCategory = scanContent(content);
          if (flagCategory) {
            message.flagged = true;
            message.flagReason = flagCategory;
            await message.save();
          }
        }

        if (mentionedUserIds.length) {
          Activity.insertMany(
            mentionedUserIds.map((uid) => ({ recipient: uid, actor: userId, type: 'mention', chat: chatId, message: message._id }))
          ).catch(() => {});
        }

        chat.lastMessage = message._id;
        chat.lastActivityAt = new Date();
        // آرشیو مثل تلگرام: پیام تازه (از دیگران) چتِ آرشیوشده‌ی «میوت‌نشده» رو خودکار از آرشیو درمیاره؛ میوت‌شده‌ها تو آرشیو می‌مونن
        for (const m of chat.members) {
          if (m.archived && m.user.toString() !== userId && !(m.mutedUntil && m.mutedUntil > new Date())) m.archived = false;
        }
        await chat.save();

        // نسخه‌ی رمزگشایی‌شده فقط برای پخش لحظه‌ای بین اعضای همین چت (نه ذخیره‌سازی)
        // برای پیام‌های e2e، content همیشه خالیه - هر کلاینت payload خودش رو از e2e.payloads پیدا و رمزگشایی می‌کنه
        const outgoing = message.toObject();
        outgoing.content = e2e || groupE2e ? '' : content;
        anonymizeChannelSender(chat, outgoing);

        io.to(`chat:${chatId}`).emit('message:new', outgoing);
        ack?.({ ok: true, message: outgoing });

        // چت خصوصی با ربات: همه‌ی پیام‌های متنی (بدون E2E - کلاینت می‌دونه طرف مقابل رباته) به ربات می‌رسه
        if (type === 'text' && chat.type === 'private' && content) {
          const otherId = chat.members.find((m) => m.user.toString() !== userId)?.user;
          const other = otherId && (await User.findById(otherId).select('isBot username displayName'));
          if (other?.isBot) botEngine.onUserMessage(io, { chat, message, text: content, fromUser: socket.user, botsOverride: [other] }).catch(() => {});
        }

        if (onlineMemberIds.length) {
          socket.to(`chat:${chatId}`).emit('message:delivered', { chatId, messageIds: [message._id], toUserIds: onlineMemberIds });
          await markFullyDelivered(chat, [message._id]);
        }

        // نوتیفیکیشن پوش برای اعضایی که الان روی سوکت آنلاین نیستند (هرکس طبق تنظیمات خودش)
        const offlineMembers = chat.members.filter((m) => m.user.toString() !== userId && !isOnline(m.user.toString()));
        if (offlineMembers.length) {
          const recipientUsers = await User.find({ _id: { $in: offlineMembers.map((m) => m.user) } }).select(
            'pushTokens notificationSettings'
          );
          const previewText = type === 'text' ? content : type === 'image' ? '📷 عکس' : type === 'video' ? '🎥 ویدیو' : type === 'voice' ? '🎤 پیام صوتی' : type === 'poll' ? '📊 نظرسنجی' : type === 'location' ? '📍 موقعیت مکانی' : type === 'contact' ? '👤 مخاطب' : 'فایل جدید';
          for (const recipient of recipientUsers) {
            const settings = recipient.notificationSettings || {};
            if (settings.enabled === false) continue; // این کاربر نوتیفیکیشن پیام رو غیرفعال کرده
            sendPushNotifications(recipient.pushTokens, {
              title: socket.user.displayName,
              body: settings.preview === false ? 'پیام جدید' : previewText.slice(0, 120),
              sound: settings.sound === false || silent === true ? null : 'default', // «ارسال بی‌صدا»: نوتیف می‌رسه ولی بدون صدا
              data: { chatId, type: 'message', recipientId: String(recipient._id) }, // برای چند حساب روی یه گوشی: این پوش مال کدوم حسابه
            });
          }
        }
      } catch (err) {
        ack?.({ error: 'ارسال پیام ناموفق بود' });
      }
    });

    socket.on('message:edit', async ({ messageId, content }) => {
      // ورودی: رشته‌ی غیرخالی با سقف طول (قبلاً undefined/شیء/متن بسیار بزرگ مستقیم رمز و ذخیره می‌شد)
      if (typeof content !== 'string' || !content.trim() || content.length > 4000) return;
      const message = await Message.findById(messageId);
      if (!message || message.sender.toString() !== userId) return;
      // پیامِ حذف‌شده برای همه دوباره «زنده» نشه (قبلاً ویرایش، محتوا رو به DB برمی‌گردوند و به اتاق می‌فرستاد)، و فرستنده‌ی بیرون‌رفته از چت دیگه تو اون چت ویرایش نمی‌کنه
      if (message.deletedForEveryone || !(await isMemberOf(message.chat))) return;
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
        let mod = false;
        if (!isSender) {
          // مدیر با حق «حذف پیام» می‌تونه پیام دیگران رو (فقط گروه/کانال) برای همه پاک کنه
          const c = await Chat.findById(message.chat);
          mod = !!c && ['group', 'channel'].includes(c.type) && chatRights.can(c, userId, 'deleteMessages');
          if (mod) chatRights.logAction(c._id, userId, 'delete_message', message.sender);
        }
        if (!isSender && !mod) return; // وگرنه فقط فرستنده
        message.deletedForEveryone = true;
        message.content = '';
        await message.save();
        // پیامِ پین‌شده‌ی حذف‌شده نباید به‌صورت بنرِ خالی تو چت بمونه
        await unpinMessages([message._id]);
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
        // فقط پیامی که خودت توش عضوی قابل فوروارده (قبلاً با دونستن messageId می‌شد محتوا/فایل هر پیامی رو به چت خودت کپی کرد)
        if (original.deletedForEveryone || !(await isMemberOf(original.chat))) return ack?.({ error: 'دسترسی ندارید' });

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
          await forwarded.populate('sender', 'username displayName avatarUrl isBot');

          chat.lastMessage = forwarded._id;
          chat.lastActivityAt = new Date();
          await chat.save();

          const outgoing = forwarded.toObject();
          outgoing.content = decryptText(outgoing.content);
          anonymizeChannelSender(chat, outgoing);
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
      if (!(await isMemberOf(message.chat))) return;
      const existingIndex = message.reactions.findIndex((r) => r.user.toString() === userId);
      let added = false;
      if (existingIndex >= 0 && message.reactions[existingIndex].emoji === emoji) {
        message.reactions.splice(existingIndex, 1); // زدن دوباره همان ایموجی = حذف ری‌اکشن
      } else if (existingIndex >= 0) {
        message.reactions[existingIndex].emoji = emoji;
        added = true;
      } else {
        message.reactions.push({ user: userId, emoji });
        added = true;
      }
      await message.save();
      io.to(`chat:${message.chat}`).emit('message:reacted', { messageId, reactions: message.reactions });

      if (added && message.sender.toString() !== userId) {
        Activity.create({ recipient: message.sender, actor: userId, type: 'reaction', chat: message.chat, message: message._id, emoji }).catch(() => {});
      }
    });

    socket.on('message:read', async ({ chatId, messageId }) => {
      await Message.findByIdAndUpdate(messageId, {
        $addToSet: { readBy: { user: userId, readAt: new Date() } },
      });
      socket.to(`chat:${chatId}`).emit('message:read', { chatId, messageId, userId });

      // خودتخریب چت مخفی: از لحظه‌ی خوانده‌شدن، شمارش معکوس شروع می‌شه
      const chat = await Chat.findById(chatId).select('type secretSettings');
      if (chat?.type === 'secret' && chat.secretSettings?.ttlSeconds > 0) {
        const expiresAt = new Date(Date.now() + chat.secretSettings.ttlSeconds * 1000);
        await Message.findByIdAndUpdate(messageId, { expiresAt });
      }
    });

    // پیامِ خودمخربِ تایم‌دار (هر چتی) - فقط وقتی گیرنده صراحتاً «باز/نمایش» می‌زنه شمارش‌معکوس شروع می‌شه،
    // نه با صرفِ رسیدن/دیده‌شدنِ پیام تو لیست. idempotent: اگه قبلاً شروع شده بود همون زمان رو برمی‌گردونه.
    socket.on('message:reveal', async ({ messageId }, ack) => {
      const message = await Message.findById(messageId);
      if (!message) return ack?.({ error: 'پیام یافت نشد' });
      if (!(await isMemberOf(message.chat))) return ack?.({ error: 'دسترسی ندارید' });
      if (!message.viewOnceDurationSec) return ack?.({ error: 'این پیام تایم‌دار نیست' });
      if (!message.expiresAt) {
        message.expiresAt = new Date(Date.now() + message.viewOnceDurationSec * 1000);
        await message.save();
        io.to(`chat:${message.chat}`).emit('message:revealed', { messageId, expiresAt: message.expiresAt, openedBy: userId });
      }
      ack?.({ ok: true, expiresAt: message.expiresAt });
    });

    socket.on('typing:start', ({ chatId }) => {
      socket.to(`chat:${chatId}`).emit('typing:start', { chatId, userId });
    });
    socket.on('typing:stop', ({ chatId }) => {
      socket.to(`chat:${chatId}`).emit('typing:stop', { chatId, userId });
    });

    socket.on('chat:join', ({ chatId }) => socket.join(`chat:${chatId}`));

    // --- تماس صوتی/تصویری (سیگنالینگ WebRTC) ---
    // رأی دادن به نظرسنجی: هر کاربر یک رأی (یا چندتا اگه نظرسنجی چندگزینه‌ایه - کلاینت محدود می‌کنه)؛ دوباره‌دادن جایگزین رأی قبلیه
    // گروه/کانال E2E است؛ فقط پیام‌هایی که «دستور / منشنِ ربات / ریپلای به ربات» هستن رو خودِ کاربر (کلاینت)
    // به‌صورت صریح برای ربات می‌فرسته. بقیه‌ی پیام‌های گروه هیچ‌وقت برای ربات ارسال نمی‌شن.
    socket.on('bot:deliver', async ({ chatId, messageId, text }) => {
      try {
        if (typeof text !== 'string' || !text || text.length > 4000) return;
        const chat = await Chat.findById(chatId);
        if (!chat || !chat.members.some((m) => m.user.toString() === userId)) return;
        const message = await Message.findOne({ _id: messageId, chat: chatId, sender: userId });
        if (!message) return;
        await botEngine.onUserMessage(io, { chat, message, text, fromUser: socket.user });
      } catch (err) { /* ignore */ }
    });

    socket.on('bot:callback', async ({ messageId, data }) => {
      try {
        const msg = await Message.findById(messageId);
        if (!msg || !msg.viaBot) return;
        const chat = await Chat.findById(msg.chat);
        if (!chat || !chat.members.some((m) => m.user.toString() === userId)) return;
        await botEngine.onCallback(io, { chat, botMsg: msg, fromUser: socket.user, data });
      } catch (err) { /* ignore */ }
    });

    // بازدید پست‌های کانال: هر کاربر یکبار به‌ازای هر پست؛ شمارنده برای همه پخش می‌شه
    socket.on('channel:view', async ({ chatId, messageIds }) => {
      try {
        if (!Array.isArray(messageIds) || !messageIds.length) return;
        const chat = await Chat.findById(chatId).select('type members');
        if (!chat || chat.type !== 'channel' || !chat.members.some((m) => m.user.toString() === userId)) return;
        const ids = messageIds.slice(0, 30);
        const changed = [];
        for (const id of ids) {
          const r = await Message.updateOne({ _id: id, chat: chatId, sender: { $ne: userId }, viewedBy: { $ne: userId } }, { $addToSet: { viewedBy: userId }, $inc: { views: 1 } });
          if (r.modifiedCount) changed.push(id);
        }
        if (changed.length) {
          const rows = await Message.find({ _id: { $in: changed } }).select('views');
          io.to(`chat:${chatId}`).emit('message:views', { chatId, views: rows.map((m) => ({ messageId: m._id.toString(), views: m.views })) });
        }
      } catch (err) { /* ignore */ }
    });

    socket.on('poll:vote', async ({ messageId, options }, ack) => {
      try {
        const msg = await Message.findById(messageId);
        if (!msg || msg.type !== 'poll') return ack?.({ error: 'نظرسنجی پیدا نشد' });
        const chat = await Chat.findById(msg.chat).select('members');
        if (!chat?.members.some((m) => m.user.toString() === userId)) return ack?.({ error: 'عضو نیستید' });
        const clean = [...new Set((Array.isArray(options) ? options : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 12))].slice(0, 12);
        msg.pollVotes = (msg.pollVotes || []).filter((v) => v.user.toString() !== userId);
        if (clean.length) msg.pollVotes.push({ user: userId, options: clean });
        await msg.save();
        const votes = msg.pollVotes.map((v) => ({ user: v.user.toString(), options: v.options }));
        io.to(`chat:${msg.chat}`).emit('poll:update', { messageId: msg._id.toString(), votes });
        ack?.({ ok: true, votes });
      } catch (err) { ack?.({ error: 'خطا' }); }
    });

    socket.on('call:invite', async ({ chatId, calleeId, kind }) => {
      const callBlocked = await restrictionGuard(userId, 'calls');
      if (callBlocked) return socket.emit('restriction:error', { message: callBlocked });
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
          data: { chatId, type: 'call', callId: callLog._id.toString(), kind, callerId: userId, recipientId: String(calleeId) },
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

  // جاروب دوره‌ای پیام‌های چت مخفیِ زمان‌شون تموم شده (خودتخریب)
  // هر ۲۰ ثانیه چک می‌کنه — یعنی حذف واقعی ممکنه چند ثانیه بعد از سررسید انجام بشه، نه دقیقاً لحظه‌ای
  setInterval(async () => {
    const expired = await Message.find({ expiresAt: { $lte: new Date() }, deletedForEveryone: { $ne: true } }).select('_id chat');
    if (!expired.length) return;
    await Message.updateMany(
      { _id: { $in: expired.map((m) => m._id) } },
      { deletedForEveryone: true, content: '', expiresAt: null }
    );
    await unpinMessages(expired.map((m) => m._id));
    expired.forEach((m) => io.to(`chat:${m.chat}`).emit('message:deleted', { messageId: m._id, forEveryone: true }));
  }, 20000);

  // جاروب دوره‌ای نگهداری کلی پیام‌ها روی سرور — طبق تنظیمات پنل ادمین (models/Settings.js):
  // پیام تحویل‌شده بعد از messageRetentionSec حذف می‌شه، پیام نرسیده بعد از undeliveredMaxWaitSec
  startRetentionScheduler();

  // جاروب دوره‌ای پیام‌های زمان‌دار - هر ۱۵ ثانیه چک می‌کنه چیزی سررسیدش رسیده یا نه (طبق ساعتِ
  // خودِ سرور، نه گوشیِ فرستنده - دقیقاً همون چیزی که برای اختلاف‌ساعت لازم بود)
  setInterval(async () => {
    const due = await ScheduledMessage.find({ status: 'pending', scheduledFor: { $lte: new Date() } }).limit(50);
    for (const sched of due) {
      try {
        const chat = await Chat.findById(sched.chat);
        const stillMember = chat?.members.some((m) => m.user.toString() === sched.sender.toString());
        if (!chat || !stillMember) {
          sched.status = 'cancelled';
          await sched.save();
          continue;
        }
        const onlineMemberIds = chat.members
          .filter((m) => m.user.toString() !== sched.sender.toString() && isOnline(m.user.toString()))
          .map((m) => m.user);

        const message = await Message.create({
          chat: sched.chat,
          sender: sched.sender,
          clientId: sched.clientId,
          type: sched.type,
          content: sched.e2e || sched.groupE2e ? '' : chat.type === 'secret' ? sched.content : encryptText(sched.content),
          e2e: sched.e2e || undefined,
          groupE2e: sched.groupE2e || undefined,
          mediaUrl: sched.mediaUrl,
          mediaMeta: sched.mediaMeta,
          replyTo: sched.replyTo,
          deliveredTo: onlineMemberIds.map((u) => ({ user: u })),
        });
        await message.populate('sender', 'username displayName avatarUrl isBot');

        if (sched.type === 'text' && chat.type !== 'secret' && !sched.e2e && !sched.groupE2e) {
          const flagCategory = scanContent(sched.content);
          if (flagCategory) {
            message.flagged = true;
            message.flagReason = flagCategory;
            await message.save();
          }
        }

        chat.lastMessage = message._id;
        chat.lastActivityAt = new Date();
        await chat.save();

        const outgoing = message.toObject();
        outgoing.content = sched.e2e || sched.groupE2e ? '' : sched.content;
        anonymizeChannelSender(chat, outgoing);
        io.to(`chat:${sched.chat}`).emit('message:new', outgoing);
        if (onlineMemberIds.length) {
          io.to(`chat:${sched.chat}`).emit('message:delivered', { chatId: sched.chat, messageIds: [message._id], toUserIds: onlineMemberIds });
          await markFullyDelivered(chat, [message._id]);
        }

        sched.status = 'sent';
        await sched.save();
      } catch (err) {
        console.error('[scheduled-message] خطا در ارسال:', err);
        sched.status = 'failed';
        await sched.save().catch(() => {});
      }
    }
  }, 15000);
};
