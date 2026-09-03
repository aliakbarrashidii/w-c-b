const express = require('express');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const { decryptText } = require('../utils/crypto');

const router = express.Router();

// لیست چت‌های من (خصوصی و گروهی)، مرتب بر اساس آخرین فعالیت
router.get('/', requireAuth, async (req, res) => {
  const chats = await Chat.find({ 'members.user': req.user._id })
    .sort({ lastActivityAt: -1 })
    .populate('members.user', 'username displayName avatarUrl isOnline lastSeen')
    .populate('lastMessage');
  res.json(chats);
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
