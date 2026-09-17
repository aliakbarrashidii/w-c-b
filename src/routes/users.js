const express = require('express');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// پیدا کردن دقیق یک کاربر با آیدی (یوزرنیم) — نه سرچ آزاد؛ باید آیدی رو از قبل بدونی
router.get('/by-username/:username', requireAuth, async (req, res) => {
  const clean = req.params.username.toLowerCase().trim().replace(/^@/, '');
  const user = await User.findOne({ username: clean, status: 'active' }).select('username displayName avatarUrl bio isOnline lastSeen coverId');
  if (!user) return res.status(404).json({ error: 'کاربری با این آیدی پیدا نشد' });
  res.json(user);
});

// تطبیق مخاطبین (مثل تلگرام): کلاینت فقط هش شماره‌های دفترچه تلفن گوشی را می‌فرستد،
// سرور هرگز شماره‌ی خام را نمی‌بیند و به هیچ کاربر دیگری هم شماره کسی را نشان نمی‌دهد.
// این جایگزین سرچ آزاد/دفترتلفن عمومی است — کاربری که مخاطبش نیستی قابل کشف نیست.
router.post('/contacts/sync', requireAuth, async (req, res) => {
  const { hashes = [] } = req.body;
  if (!Array.isArray(hashes) || hashes.length === 0) return res.json([]);
  if (hashes.length > 5000) return res.status(400).json({ error: 'تعداد مخاطبین بیش از حد مجاز است' });

  const matches = await User.find({
    phoneHash: { $in: hashes },
    _id: { $ne: req.user._id },
    status: 'active',
  }).select('username displayName avatarUrl bio isOnline lastSeen coverId');

  res.json(matches);
});

router.get('/:id', requireAuth, async (req, res) => {
  const user = await User.findById(req.params.id).select('username displayName avatarUrl bio isOnline lastSeen privacy coverId');
  if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });

  const obj = user.toObject();
  const isSelf = req.params.id === req.user._id.toString();
  if (!isSelf) {
    const mode = obj.privacy?.lastSeenVisibility || 'everyone';
    const exceptions = (obj.privacy?.lastSeenExceptions || []).map((id) => id.toString());
    const isException = exceptions.includes(req.user._id.toString());
    // everyone + تو تو لیست استثنایی: ازت مخفیه. nobody + تو تو لیست استثنایی: برات نشون داده می‌شه.
    const hidden = mode === 'everyone' ? isException : !isException;
    if (hidden) {
      obj.isOnline = false;
      obj.lastSeen = null;
    }
  }
  delete obj.privacy;
  res.json(obj);
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

// یادداشت خصوصی روی یک مخاطب — فقط خودم می‌بینم، هیچ‌وقت به کسی دیگه نمایش داده نمی‌شه
router.get('/:id/note', requireAuth, async (req, res) => {
  const entry = req.user.contactNotes.find((n) => n.contact.toString() === req.params.id);
  res.json({ note: entry?.note || '' });
});

router.put('/:id/note', requireAuth, async (req, res) => {
  const { note = '' } = req.body;
  const entry = req.user.contactNotes.find((n) => n.contact.toString() === req.params.id);
  if (entry) entry.note = note;
  else req.user.contactNotes.push({ contact: req.params.id, note });
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
