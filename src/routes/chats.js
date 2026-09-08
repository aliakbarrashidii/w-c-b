const express = require('express');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const { decryptText } = require('../utils/crypto');

const router = express.Router();

function myMembership(chat, userId) {
  return chat.members.find((m) => m.user.toString() === userId.toString() || m.user._id?.toString() === userId.toString());
}

// لیست چت‌های من (خصوصی و گروهی)، مرتب بر اساس آخرین فعالیت
router.get('/', requireAuth, async (req, res) => {
  const { archived } = req.query;
  const chats = await Chat.find({ 'members.user': req.user._id })
    .sort({ lastActivityAt: -1 })
    .populate('members.user', 'username displayName avatarUrl isOnline lastSeen')
    .populate('lastMessage');

  const filtered = chats.filter((c) => {
    const me = myMembership(c, req.user._id);
    const isArchived = !!me?.archived;
    return archived === 'true' ? isArchived : !isArchived;
  });

  const decrypted = await Promise.all(
    filtered.map(async (c) => {
      const obj = c.toObject();
      if (obj.lastMessage) obj.lastMessage.content = decryptText(obj.lastMessage.content);
      const me = myMembership(c, req.user._id);
      obj.myState = { muted: !!(me?.mutedUntil && me.mutedUntil > new Date()), archived: !!me?.archived, pinnedInList: !!me?.pinnedInList, wallpaper: me?.wallpaper || null };
      obj.unreadCount = await Message.countDocuments({
        chat: c._id,
        sender: { $ne: req.user._id },
        'readBy.user': { $ne: req.user._id },
        deletedForEveryone: { $ne: true },
        ...(me?.clearedAt ? { createdAt: { $gt: me.clearedAt } } : {}),
      });
      return obj;
    })
  );

  decrypted.sort((a, b) => (b.myState.pinnedInList - a.myState.pinnedInList) || (new Date(b.lastActivityAt) - new Date(a.lastActivityAt)));
  res.json(decrypted);
});

// آرشیو / آنآرشیو
router.post('/:chatId/archive', requireAuth, async (req, res) => {
  const { archived } = req.body;
  const chat = await Chat.findById(req.params.chatId);
  const me = myMembership(chat, req.user._id);
  if (!me) return res.status(403).json({ error: 'شما عضو این چت نیستید' });
  me.archived = !!archived;
  await chat.save();
  res.json({ ok: true });
});

// میوت / آنمیوت
router.post('/:chatId/mute', requireAuth, async (req, res) => {
  const { muted, hours } = req.body;
  const chat = await Chat.findById(req.params.chatId);
  const me = myMembership(chat, req.user._id);
  if (!me) return res.status(403).json({ error: 'شما عضو این چت نیستید' });
  me.mutedUntil = muted ? new Date(Date.now() + (hours || 24 * 365) * 3600 * 1000) : null;
  await chat.save();
  res.json({ ok: true, mutedUntil: me.mutedUntil });
});

// پس‌زمینه‌ی اختصاصی این چت (فقط برای خودم — طرف مقابل چیزی نمی‌بینه)
router.post('/:chatId/wallpaper', requireAuth, async (req, res) => {
  const { wallpaper } = req.body; // رنگ هگز، یا null برای برگشت به پیش‌فرض تم
  const chat = await Chat.findById(req.params.chatId);
  const me = myMembership(chat, req.user._id);
  if (!me) return res.status(403).json({ error: 'شما عضو این چت نیستید' });
  me.wallpaper = wallpaper || null;
  await chat.save();
  res.json({ ok: true });
});

// پین‌کردن چت در بالای لیست
router.post('/:chatId/pin-list', requireAuth, async (req, res) => {
  const { pinned } = req.body;
  const chat = await Chat.findById(req.params.chatId);
  const me = myMembership(chat, req.user._id);
  if (!me) return res.status(403).json({ error: 'شما عضو این چت نیستید' });
  me.pinnedInList = !!pinned;
  await chat.save();
  res.json({ ok: true });
});

// علامت‌گذاری همه‌ی پیام‌های چت به‌عنوان خوانده‌شده
router.post('/:chatId/mark-read', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId);
  if (!myMembership(chat, req.user._id)) return res.status(403).json({ error: 'شما عضو این چت نیستید' });
  await Message.updateMany(
    { chat: chat._id, sender: { $ne: req.user._id }, 'readBy.user': { $ne: req.user._id } },
    { $addToSet: { readBy: { user: req.user._id, readAt: new Date() } } }
  );
  res.json({ ok: true });
});

// پاک کردن تاریخچه (فقط برای خودم — پیام‌های قبل از الان دیگه تو این چت برام نمایش داده نمی‌شن)
router.post('/:chatId/clear-history', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId);
  const me = myMembership(chat, req.user._id);
  if (!me) return res.status(403).json({ error: 'شما عضو این چت نیستید' });
  me.clearedAt = new Date();
  await chat.save();
  res.json({ ok: true });
});

// شروع چت خصوصی با یک کاربر (اگر از قبل وجود داشته باشد همان را برمی‌گرداند)
router.post('/private', requireAuth, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'شناسه کاربر الزامی است' });

  const other = await User.findById(userId);
  if (!other) return res.status(404).json({ error: 'کاربر یافت نشد' });

  let chat = await Chat.findOne({
    type: 'private',
    'members.user': { $all: [req.user._id, other._id] },
    $expr: { $eq: [{ $size: '$members' }, 2] },
  });

  if (!chat) {
    chat = await Chat.create({
      type: 'private',
      members: [{ user: req.user._id }, { user: other._id }],
    });
  }
  res.json(chat);
});

// چت «پیام‌های ذخیره‌شده» شخصی (اگر وجود نداشته باشد می‌سازد)
router.get('/saved', requireAuth, async (req, res) => {
  let chat = await Chat.findOne({ type: 'saved', 'members.user': req.user._id });
  if (!chat) {
    chat = await Chat.create({ type: 'saved', members: [{ user: req.user._id, role: 'owner' }] });
  }
  res.json(chat);
});

// پین/آنپین پیام در یک چت
router.post('/:chatId/pin', requireAuth, async (req, res) => {
  const { messageId } = req.body;
  const chat = await Chat.findById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: 'چت یافت نشد' });
  const isMember = chat.members.some((m) => m.user.toString() === req.user._id.toString());
  if (!isMember) return res.status(403).json({ error: 'شما عضو این چت نیستید' });
  chat.pinnedMessage = messageId || null;
  await chat.save();
  res.json({ ok: true, pinnedMessage: chat.pinnedMessage });
});

// ساخت گروه
router.post('/group', requireAuth, async (req, res) => {
  const { title, description, memberIds = [] } = req.body;
  if (!title) return res.status(400).json({ error: 'عنوان گروه الزامی است' });

  const members = [{ user: req.user._id, role: 'owner' }, ...memberIds.map((id) => ({ user: id, role: 'member' }))];

  const chat = await Chat.create({ type: 'group', title, description, members });
  res.status(201).json(chat);
});

// جزئیات یک چت (برای هدر و بنر پیام پین‌شده)
router.get('/:chatId', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId)
    .populate('members.user', 'username displayName avatarUrl isOnline lastSeen')
    .populate('pinnedMessage');
  if (!chat) return res.status(404).json({ error: 'چت یافت نشد' });
  const isMember = chat.members.some((m) => m.user._id.toString() === req.user._id.toString());
  if (!isMember) return res.status(403).json({ error: 'شما عضو این چت نیستید' });

  const obj = chat.toObject();
  if (obj.pinnedMessage) obj.pinnedMessage.content = decryptText(obj.pinnedMessage.content);
  const me = myMembership(chat, req.user._id);
  obj.myState = { muted: !!(me?.mutedUntil && me.mutedUntil > new Date()), archived: !!me?.archived, pinnedInList: !!me?.pinnedInList, wallpaper: me?.wallpaper || null };
  res.json(obj);
});

// پیام‌های یک چت (صفحه‌بندی شده)
router.get('/:chatId/messages', requireAuth, async (req, res) => {
  const { chatId } = req.params;
  const { before, limit = 30 } = req.query;

  const chat = await Chat.findById(chatId);
  if (!chat) return res.status(404).json({ error: 'چت یافت نشد' });
  const isMember = chat.members.some((m) => m.user.toString() === req.user._id.toString());
  if (!isMember) return res.status(403).json({ error: 'شما عضو این چت نیستید' });

  const query = { chat: chatId, deletedFor: { $ne: req.user._id } };
  if (before) query.createdAt = { $lt: new Date(before) };
  const me = chat.members.find((m) => m.user.toString() === req.user._id.toString());
  if (me?.clearedAt) {
    query.createdAt = { ...(query.createdAt || {}), $gt: me.clearedAt };
  }

  const messages = await Message.find(query)
    .sort({ createdAt: -1 })
    .limit(Number(limit))
    .populate('sender', 'username displayName avatarUrl')
    .populate('replyTo');

  const decrypted = messages.map((m) => {
    const obj = m.toObject();
    obj.content = decryptText(obj.content);
    if (obj.replyTo) obj.replyTo.content = decryptText(obj.replyTo.content);
    return obj;
  });

  res.json(decrypted.reverse());
});

module.exports = router;
