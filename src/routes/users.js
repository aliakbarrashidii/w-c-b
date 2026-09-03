const express = require('express');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/search', requireAuth, async (req, res) => {
  const { q = '' } = req.query;
  if (!q.trim()) return res.json([]);
  const users = await User.find({
    $text: { $search: q },
    _id: { $ne: req.user._id },
  })
    .select('username displayName avatarUrl bio isOnline lastSeen')
    .limit(20);
  res.json(users);
});

router.get('/:id', requireAuth, async (req, res) => {
  const user = await User.findById(req.params.id).select('username displayName avatarUrl bio isOnline lastSeen');
  if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });
  res.json(user);
});

router.post('/:id/block', requireAuth, async (req, res) => {
  if (!req.user.blockedUsers.includes(req.params.id)) {
    req.user.blockedUsers.push(req.params.id);
    await req.user.save();
  }
  res.json({ ok: true });
});

router.post('/:id/unblock', requireAuth, async (req, res) => {
  req.user.blockedUsers = req.user.blockedUsers.filter((id) => id.toString() !== req.params.id);
  await req.user.save();
  res.json({ ok: true });
});

// ثبت توکن پوش این دستگاه (برای دریافت نوتیفیکیشن پیام/تماس)
router.post('/me/push-token', requireAuth, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'توکن الزامی است' });
  if (!req.user.pushTokens.includes(token)) {
    req.user.pushTokens.push(token);
    await req.user.save();
  }
  res.json({ ok: true });
});

router.delete('/me/push-token', requireAuth, async (req, res) => {
  const { token } = req.body;
  req.user.pushTokens = req.user.pushTokens.filter((t) => t !== token);
  await req.user.save();
  res.json({ ok: true });
});

module.exports = router;
