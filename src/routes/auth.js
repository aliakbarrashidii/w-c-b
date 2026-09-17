const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const User = require('../models/User');
const Session = require('../models/Session');
const InviteCode = require('../models/InviteCode');
const ContactRequest = require('../models/ContactRequest');
const { requireAuth } = require('../middleware/auth');
const { normalizeIranPhone } = require('../utils/phone');
const { hashPhone } = require('../utils/crypto');

const router = express.Router();

function signToken(user, sessionId) {
  return jwt.sign({ id: user._id, role: user.role, sid: sessionId }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

function tempTwoFactorToken(user) {
  return jwt.sign({ id: user._id, twoFactorPending: true }, process.env.JWT_SECRET, { expiresIn: '10m' });
}

async function createSession(user, req) {
  const session = await Session.create({
    user: user._id,
    deviceName: req.body.deviceName || 'دستگاه ناشناس',
    userAgent: req.headers['user-agent'] || '',
    ip: req.ip,
  });
  return session;
}

// ثبت‌نام مستقیم داخل اپ (بدون نیاز به ادمین) — فقط نام، شماره موبایل و رمز عبور
router.post('/register', async (req, res) => {
  try {
    const { displayName, phone, password, inviteCode } = req.body;
    if (!displayName?.trim() || !phone || !password) {
      return res.status(400).json({ error: 'نام، شماره موبایل و رمز عبور الزامی است' });
    }
    if (!inviteCode?.trim()) {
      return res.status(400).json({ error: 'ثبت‌نام فقط با کد دعوت امکان‌پذیر است' });
    }
    const invite = await InviteCode.findOne({ code: inviteCode.trim().toUpperCase(), usedBy: null });
    if (!invite) {
      return res.status(400).json({ error: 'کد دعوت نامعتبر یا قبلاً استفاده‌شده است' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'رمز عبور باید حداقل ۶ کاراکتر باشد' });
    }

    const normalizedPhone = normalizeIranPhone(phone);
    if (!normalizedPhone) {
      return res.status(400).json({ error: 'فرمت شماره موبایل معتبر نیست (مثال: ۰۹۱۲۳۴۵۶۷۸۹)' });
    }

    const phoneHash = hashPhone(normalizedPhone);
    const existing = await User.findOne({ phoneHash });
    if (existing) return res.status(409).json({ error: 'حسابی با این شماره موبایل قبلاً ساخته شده است' });

    // یوزرنیم داخلی فقط برای ورود جایگزین ساخته می‌شود، جایی به کاربر دیگر نمایش داده نمی‌شود
    let username = normalizedPhone.replace('+98', '0');
    let suffix = 0;
    while (await User.findOne({ username })) {
      suffix += 1;
      username = `${normalizedPhone.replace('+98', '0')}_${suffix}`;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      username,
      displayName: displayName.trim(),
      passwordHash,
      phone: normalizedPhone,
      phoneHash,
    });

    invite.usedBy = user._id;
    invite.usedAt = new Date();
    await invite.save();

    const session = await createSession(user, req);
    user.isOnline = true;
    user.lastSeen = new Date();
    await user.save();

    const token = signToken(user, session._id);
    res.status(201).json({
      token,
      user: {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        role: user.role,
        theme: user.theme,
        twoFactorEnabled: user.twoFactorEnabled,
        privacy: user.privacy,
        notificationSettings: user.notificationSettings,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'خطای سرور' });
  }
});

// پیام تماس با ادمین قبل از ثبت‌نام (وقتی کد دعوت نداری) — نیازی به لاگین نداره
router.post('/contact-request', async (req, res) => {
  const { name, phone, message } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'نام الزامی است' });
  await ContactRequest.create({ name: name.trim(), phone: phone?.trim() || '', message: message?.trim() || '' });
  res.status(201).json({ ok: true });
});

// ورود با نام‌کاربری/رمز عبور (کاربرها فعلاً دستی توسط ادمین ساخته می‌شوند)
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'نام کاربری و رمز عبور الزامی است' });

    // ورود هم با نام‌کاربری و هم با شماره موبایل پشتیبانی می‌شود
    const asPhone = normalizeIranPhone(username);
    const user = asPhone
      ? await User.findOne({ phoneHash: hashPhone(asPhone) })
      : await User.findOne({ username: username.toLowerCase().trim() });
    if (!user) return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });
    if (user.status === 'banned') return res.status(403).json({ error: 'حساب شما مسدود شده است' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });

    if (user.twoFactorEnabled) {
      return res.json({ twoFactorRequired: true, tempToken: tempTwoFactorToken(user) });
    }

    const session = await createSession(user, req);
    user.isOnline = true;
    user.lastSeen = new Date();
    await user.save();

    const token = signToken(user, session._id);
    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        role: user.role,
        theme: user.theme,
        twoFactorEnabled: user.twoFactorEnabled,
        privacy: user.privacy,
        notificationSettings: user.notificationSettings,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'خطای سرور' });
  }
});

// مرحله دوم ورود وقتی 2FA فعال است
router.post('/login/2fa', async (req, res) => {
  try {
    const { tempToken, code } = req.body;
    if (!tempToken || !code) return res.status(400).json({ error: 'کد و توکن موقت الزامی است' });

    let payload;
    try {
      payload = jwt.verify(tempToken, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'توکن موقت نامعتبر یا منقضی شده است' });
    }
    if (!payload.twoFactorPending) return res.status(401).json({ error: 'درخواست نامعتبر' });

    const user = await User.findById(payload.id);
    if (!user || !user.twoFactorEnabled) return res.status(401).json({ error: 'درخواست نامعتبر' });

    const valid = authenticator.verify({ token: code, secret: user.twoFactorSecret });
    if (!valid) return res.status(401).json({ error: 'کد تایید اشتباه است' });

    const session = await createSession(user, req);
    user.isOnline = true;
    user.lastSeen = new Date();
    await user.save();

    const token = signToken(user, session._id);
    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        role: user.role,
        theme: user.theme,
        twoFactorEnabled: user.twoFactorEnabled,
        privacy: user.privacy,
        notificationSettings: user.notificationSettings,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'خطای سرور' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  await req.user.populate('privacy.lastSeenExceptions', 'username displayName avatarUrl');
  const u = req.user;
  res.json({
    id: u._id,
    username: u.username,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    bio: u.bio,
    role: u.role,
    theme: u.theme,
    twoFactorEnabled: u.twoFactorEnabled,
    privacy: u.privacy,
    notificationSettings: u.notificationSettings,
    defaultWallpaper: u.defaultWallpaper,
    avatarUrls: u.avatarUrls,
    coverId: u.coverId,
  });
});

router.patch('/me', requireAuth, async (req, res) => {
  const { displayName, bio, avatarUrl, theme, defaultWallpaper, coverId } = req.body;
  if (displayName !== undefined) req.user.displayName = displayName;
  if (bio !== undefined) req.user.bio = bio;
  if (avatarUrl !== undefined) req.user.avatarUrl = avatarUrl;
  if (theme !== undefined) req.user.theme = theme;
  if (defaultWallpaper !== undefined) req.user.defaultWallpaper = defaultWallpaper;
  if (coverId !== undefined) req.user.coverId = coverId;
  await req.user.save();
  res.json({ ok: true, defaultWallpaper: req.user.defaultWallpaper, coverId: req.user.coverId });
});

// افزودن عکس پروفایل جدید (به آرشیو اضافه می‌شه و همون لحظه فعلی می‌شه)
router.post('/me/avatars', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'آدرس عکس الزامی است' });
  if (!req.user.avatarUrls.includes(url)) req.user.avatarUrls.unshift(url);
  req.user.avatarUrl = url;
  await req.user.save();
  res.json({ ok: true, avatarUrl: url, avatarUrls: req.user.avatarUrls });
});

// حذف یکی از عکس‌های پروفایل قدیمی
router.delete('/me/avatars', requireAuth, async (req, res) => {
  const { url } = req.body;
  req.user.avatarUrls = req.user.avatarUrls.filter((u) => u !== url);
  if (req.user.avatarUrl === url) req.user.avatarUrl = req.user.avatarUrls[0] || '';
  await req.user.save();
  res.json({ ok: true, avatarUrl: req.user.avatarUrl, avatarUrls: req.user.avatarUrls });
});

router.patch('/me/privacy', requireAuth, async (req, res) => {
  const { lastSeenVisibility, readReceiptsEnabled, lastSeenExceptions } = req.body;
  if (lastSeenVisibility !== undefined) req.user.privacy.lastSeenVisibility = lastSeenVisibility;
  if (readReceiptsEnabled !== undefined) req.user.privacy.readReceiptsEnabled = readReceiptsEnabled;
  if (lastSeenExceptions !== undefined) req.user.privacy.lastSeenExceptions = lastSeenExceptions;
  await req.user.save();
  await req.user.populate('privacy.lastSeenExceptions', 'username displayName avatarUrl');
  res.json({ ok: true, privacy: req.user.privacy });
});

router.patch('/me/notifications', requireAuth, async (req, res) => {
  const { enabled, sound, preview } = req.body;
  if (enabled !== undefined) req.user.notificationSettings.enabled = enabled;
  if (sound !== undefined) req.user.notificationSettings.sound = sound;
  if (preview !== undefined) req.user.notificationSettings.preview = preview;
  await req.user.save();
  res.json({ ok: true, notificationSettings: req.user.notificationSettings });
});

router.post('/logout', requireAuth, async (req, res) => {
  if (req.sessionId) {
    await Session.findByIdAndUpdate(req.sessionId, { revoked: true });
  }
  req.user.isOnline = false;
  req.user.lastSeen = new Date();
  await req.user.save();
  res.json({ ok: true });
});

// --- مدیریت نشست‌ها / دستگاه‌ها ---
router.get('/sessions', requireAuth, async (req, res) => {
  const sessions = await Session.find({ user: req.user._id, revoked: false }).sort({ lastActiveAt: -1 });
  res.json(sessions.map((s) => ({ ...s.toObject(), isCurrent: s._id.toString() === req.sessionId?.toString() })));
});

router.delete('/sessions/:id', requireAuth, async (req, res) => {
  const session = await Session.findOne({ _id: req.params.id, user: req.user._id });
  if (!session) return res.status(404).json({ error: 'نشست یافت نشد' });
  session.revoked = true;
  await session.save();
  res.json({ ok: true });
});

router.post('/sessions/revoke-all-others', requireAuth, async (req, res) => {
  await Session.updateMany(
    { user: req.user._id, _id: { $ne: req.sessionId } },
    { revoked: true }
  );
  res.json({ ok: true });
});

// --- تایید دو مرحله‌ای (TOTP) ---
router.post('/2fa/setup', requireAuth, async (req, res) => {
  const secret = authenticator.generateSecret();
  req.user.twoFactorSecret = secret; // فقط پس از تایید کد در enable/ فعال می‌شود
  await req.user.save();
  const otpauth = authenticator.keyuri(req.user.username, 'WizChat', secret);
  res.json({ secret, otpauth });
});

router.post('/2fa/enable', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!req.user.twoFactorSecret) return res.status(400).json({ error: 'ابتدا باید 2FA را راه‌اندازی کنی' });
  const valid = authenticator.verify({ token: code, secret: req.user.twoFactorSecret });
  if (!valid) return res.status(400).json({ error: 'کد تایید اشتباه است' });
  req.user.twoFactorEnabled = true;
  await req.user.save();
  res.json({ ok: true });
});

router.post('/2fa/disable', requireAuth, async (req, res) => {
  const { password } = req.body;
  const valid = await bcrypt.compare(password || '', req.user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'رمز عبور اشتباه است' });
  req.user.twoFactorEnabled = false;
  req.user.twoFactorSecret = '';
  await req.user.save();
  res.json({ ok: true });
});

// تغییر رمز عبور — لازمه چون خیلی از حساب‌ها رو ادمین/ناظر با یه رمز موقت می‌سازه
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'رمز جدید باید حداقل ۶ کاراکتر باشد' });
  }
  const valid = await bcrypt.compare(currentPassword || '', req.user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'رمز فعلی اشتباه است' });
  req.user.passwordHash = await bcrypt.hash(newPassword, 10);
  await req.user.save();
  res.json({ ok: true });
});

// تغییر نام کاربری/آیدی (برای اینکه دیگران بتونن با آیدی پیدات کنن، نه فقط شماره)
router.patch('/me/username', requireAuth, async (req, res) => {
  const { username } = req.body;
  const clean = (username || '').toLowerCase().trim();
  if (!/^[a-z0-9_]{4,32}$/.test(clean)) {
    return res.status(400).json({ error: 'آیدی باید ۴ تا ۳۲ کاراکتر انگلیسی/عدد/آندرلاین باشد' });
  }
  const exists = await User.findOne({ username: clean, _id: { $ne: req.user._id } });
  if (exists) return res.status(409).json({ error: 'این آیدی قبلاً گرفته شده است' });
  req.user.username = clean;
  await req.user.save();
  res.json({ ok: true, username: clean });
});

module.exports = router;
