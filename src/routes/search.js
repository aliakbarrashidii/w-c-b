const express = require('express');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const { requireAuth } = require('../middleware/auth');
const { decryptText } = require('../utils/crypto');

const router = express.Router();

// جستجو فقط داخل چت‌ها/گروه‌ها و پیام‌های خودِ کاربر — عمداً کاربران دیگر اپ را جستجوپذیر نمی‌کند
// (طبق تصمیم محصول: کشف کاربر فقط از طریق تطبیق مخاطبین در /api/users/contacts/sync انجام می‌شود، نه سرچ آزاد)
router.get('/', requireAuth, async (req, res) => {
  const { q = '' } = req.query;
  const needle = q.trim();
  if (!needle) return res.json({ chats: [], messages: [] });

  const myChats = await Chat.find({ 'members.user': req.user._id }).populate(
    'members.user',
    'username displayName avatarUrl'
  );

  const lowerNeedle = needle.toLowerCase();

  const matchedChats = myChats
    .filter((c) => {
      if (c.type === 'group') return c.title?.toLowerCase().includes(lowerNeedle);
      const other = c.members.find((m) => m.user._id.toString() !== req.user._id.toString())?.user;
      return other?.displayName?.toLowerCase().includes(lowerNeedle) || other?.username?.toLowerCase().includes(lowerNeedle);
    })
    .slice(0, 15);

  // جستجوی محتوای پیام‌ها فقط داخل چت‌های خودم (پیام‌ها رمزنگاری‌شده‌اند، پس رمزگشایی+فیلتر در اپ)
  const myChatIds = myChats.map((c) => c._id);
  const recentMessages = await Message.find({ chat: { $in: myChatIds }, deletedForEveryone: { $ne: true } })
    .sort({ createdAt: -1 })
    .limit(300)
    .populate('sender', 'username displayName avatarUrl')
    .populate('chat', 'type title members');

  const matchedMessages = recentMessages
    .map((m) => {
      const obj = m.toObject();
      obj.content = decryptText(obj.content);
      return obj;
    })
    .filter((m) => m.content?.toLowerCase().includes(lowerNeedle))
    .slice(0, 20);

  res.json({ chats: matchedChats, messages: matchedMessages });
});

module.exports = router;
