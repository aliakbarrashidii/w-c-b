const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// پیدا کردن دقیق یک کاربر با آیدی (یوزرنیم) — نه سرچ آزاد؛ باید آیدی رو از قبل بدونی
router.get('/by-username/:username', requireAuth, async (req, res) => {
  const clean = req.params.username.toLowerCase().trim().replace(/^@/, '');
  const user = await User.findOne({ username: clean, status: 'active' }).select('username displayName avatarUrl bio isOnline lastSeen coverId isBot');
  if (!user) return res.status(404).json({ error: 'کاربری با این آیدی پیدا نشد' });
  res.json(user);
});

// اپ موقع باز شدن (و بعد از تغییر زبان) این رو صدا می‌زنه تا اطلاعیه‌های همگانی بشه هدف‌گیری کرد
router.post('/client-info', requireAuth, async (req, res) => {
  const clip = (v, n) => String(v || '').trim().slice(0, n);
  const language = clip(req.body?.language, 10).toLowerCase();
  const appVersion = /^\d+(\.\d+){0,3}$/.test(clip(req.body?.appVersion, 20)) ? clip(req.body.appVersion, 20) : '';
  const platform = ['ios', 'android', 'web'].includes(req.body?.platform) ? req.body.platform : '';
  await User.updateOne({ _id: req.user._id }, { $set: { 'client.language': language, 'client.appVersion': appVersion, 'client.platform': platform, 'client.reportedAt': new Date() } });
  res.json({ ok: true });
});

// تطبیق مخاطبین (مثل تلگرام): کلاینت فقط هش شماره‌های دفترچه تلفن گوشی را می‌فرستد،
// سرور هرگز شماره‌ی خام را نمی‌بیند و به هیچ کاربر دیگری هم شماره کسی را نشان نمی‌دهد.
// این جایگزین سرچ آزاد/دفترتلفن عمومی است — کاربری که مخاطبش نیستی قابل کشف نیست.
// همگام‌سازی مخاطبین = ابزار شمارش شماره‌ها (هش تلفن قابل‌محاسبه‌ست): حداکثر ۲۰ بار در ساعت برای هر کاربر
const contactSyncLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?._id),
  message: { error: 'همگام‌سازی مخاطبین بیش از حد مجاز؛ بعداً دوباره امتحان کنید' },
});
router.post('/contacts/sync', requireAuth, contactSyncLimiter, async (req, res) => {
  const { hashes = [] } = req.body;
  if (!Array.isArray(hashes) || hashes.length === 0) return res.json([]);
  if (!hashes.every((h) => typeof h === 'string' && h.length <= 128)) return res.status(400).json({ error: 'ورودی نامعتبر است' });
  if (hashes.length > 5000) return res.status(400).json({ error: 'تعداد مخاطبین بیش از حد مجاز است' });

  const matches = await User.find({
    phoneHash: { $in: hashes },
    _id: { $ne: req.user._id },
    status: 'active',
  }).select('username displayName avatarUrl bio isOnline lastSeen coverId');

  res.json(matches);
});

// ---- مخاطبین ذخیره‌شده با اسم دلخواه ----
router.get('/contacts/saved', requireAuth, async (req, res) => {
  const me = await User.findById(req.user._id).populate('savedContacts.contact', 'username displayName avatarUrl isOnline lastSeen isBot');
  res.json(me.savedContacts.filter((c) => c.contact).map((c) => ({ userId: c.contact._id, name: c.name || c.contact.displayName, user: c.contact })));
});
router.post('/contacts/save', requireAuth, async (req, res) => {
  const { userId, name } = req.body;
  if (!userId || String(userId) === String(req.user._id)) return res.status(400).json({ error: 'کاربر نامعتبر' });
  const target = await User.findById(userId).select('displayName');
  if (!target) return res.status(404).json({ error: 'کاربر یافت نشد' });
  const clean = (name || '').trim().slice(0, 60) || target.displayName;
  const existing = req.user.savedContacts.find((c) => String(c.contact) === String(userId));
  if (existing) existing.name = clean; else req.user.savedContacts.push({ contact: userId, name: clean });
  // شماره‌ی خودم برای طرف مقابل قابل‌مشاهده می‌شه (مثل تلگرام وقتی مخاطب ذخیره می‌کنی)
  if (!req.user.sharedPhoneWith.some((id) => String(id) === String(userId))) req.user.sharedPhoneWith.push(userId);
  await req.user.save();
  res.json({ ok: true, name: clean });
});
router.delete('/contacts/saved/:id', requireAuth, async (req, res) => {
  req.user.savedContacts = req.user.savedContacts.filter((c) => String(c.contact) !== req.params.id);
  await req.user.save();
  res.json({ ok: true });
});

router.get('/:id', requireAuth, async (req, res) => {
  const user = await User.findById(req.params.id).select('username displayName avatarUrl avatarUrls bio isOnline lastSeen privacy coverId phone sharedPhoneWith');
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
  // شماره فقط وقتی دیده می‌شه که صاحبش من رو به مخاطبینش اضافه کرده باشه (یا خودم باشم)
  const sharedWithMe = (obj.sharedPhoneWith || []).some((id) => String(id) === String(req.user._id));
  if (!isSelf && !sharedWithMe) delete obj.phone;
  delete obj.sharedPhoneWith;
  obj.savedName = req.user.savedContacts.find((c) => String(c.contact) === req.params.id)?.name || null;
  res.json(obj);
});

router.post('/:id/block', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id) || req.params.id === String(req.user._id)) return res.status(400).json({ error: 'کاربر نامعتبر است' });
  if (!req.user.blockedUsers.some((id) => String(id) === req.params.id)) {
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
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'کاربر نامعتبر است' });
  const note = String(req.body?.note ?? '').slice(0, 500); // سقف طول: قبلاً نامحدود بود (بزرگ‌شدنِ بی‌حدِ سند کاربر)
  const entry = req.user.contactNotes.find((n) => n.contact.toString() === req.params.id);
  if (entry) entry.note = note;
  else req.user.contactNotes.push({ contact: req.params.id, note });
  await req.user.save();
  res.json({ ok: true });
});

// ثبت توکن پوش این دستگاه (برای دریافت نوتیفیکیشن پیام/تماس)
router.post('/me/push-token', requireAuth, async (req, res) => {
  const { token } = req.body;
  // توکن باید رشته‌ی معقول باشه؛ و حداکثر ۱۰ دستگاه فعال (قدیمی‌ترین کنار می‌ره) تا سند کاربر بی‌حد بزرگ نشه
  if (typeof token !== 'string' || !token || token.length > 300) return res.status(400).json({ error: 'توکن نامعتبر است' });
  if (!req.user.pushTokens.includes(token)) {
    req.user.pushTokens.push(token);
    if (req.user.pushTokens.length > 10) req.user.pushTokens = req.user.pushTokens.slice(-10);
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
