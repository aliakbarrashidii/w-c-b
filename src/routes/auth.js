const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const User = require('../models/User');
const Session = require('../models/Session');
const { requireAuth } = require('../middleware/auth');

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

// ورود با نام‌کاربری/رمز عبور (کاربرها فعلاً دستی توسط ادمین ساخته می‌شوند)
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'نام کاربری و رمز عبور الزامی است' });

    const user = await User.findOne({ username: username.toLowerCase().trim() });
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
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'خطای سرور' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
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
  });
});

router.patch('/me', requireAuth, async (req, res) => {
  const { displayName, bio, avatarUrl, theme } = req.body;
  if (displayName !== undefined) req.user.displayName = displayName;
  if (bio !== undefined) req.user.bio = bio;
  if (avatarUrl !== undefined) req.user.avatarUrl = avatarUrl;
  if (theme !== undefined) req.user.theme = theme;
  await req.user.save();
  res.json({ ok: true });
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

module.exports = router;
