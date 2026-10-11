const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { getSettings } = require('../utils/settings');

const router = express.Router();

// ورود/ثبت‌نام با «Telegram Login Widget» رسمی:
//  ۱) اپ مرورگر رو روی GET /start باز می‌کنه (صفحه‌ی ویجتِ تلگرام)
//  ۲) تلگرام کاربر رو با داده‌ی امضاشده به GET /callback برمی‌گردونه؛ ما امضا (HMAC با توکن ربات) رو چک می‌کنیم
//  ۳) سرور یه بلیتِ یک‌بارمصرف می‌سازه و به wizchat://tg-auth?ticket=... برمی‌گردونه
//  ۴) اپ بلیت رو با POST /exchange به توکن ورود (یا اتصالِ تلگرام به حسابِ فعلی) تبدیل می‌کنه
// تنظیمات لازم (.env): TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME (بدون @), PUBLIC_BASE_URL (https، همون دامنه‌ای که تو BotFather با /setdomain ثبت شده)
const tickets = new Map(); // ticket -> { tg, exp }
setInterval(() => { const now = Date.now(); for (const [k, v] of tickets) if (v.exp < now) tickets.delete(k); }, 60000).unref();

function verifyTelegram(query, botToken) {
  const { hash, ...data } = query;
  if (!hash) return false;
  const checkString = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  const a = Buffer.from(calc), b = Buffer.from(String(hash));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Date.now() / 1000 - Number(data.auth_date || 0) < 600; // حداکثر ۱۰ دقیقه‌ی پیش
}

router.get('/start', async (req, res) => {
  const settings = await getSettings();
  if (settings.telegramLoginEnabled === false || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_BOT_USERNAME) {
    return res.status(503).send('ورود با تلگرام فعلاً فعال نیست');
  }
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.send(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ورود با تلگرام</title><style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f4f6f8}</style></head>
<body><h3>ورود به WizChat با تلگرام</h3>
<script async src="https://telegram.org/js/telegram-widget.js?22" data-telegram-login="${process.env.TELEGRAM_BOT_USERNAME}" data-size="large" data-radius="12" data-auth-url="${base}/api/auth/telegram/callback" data-request-access="write"></script>
</body></html>`);
});

router.get('/callback', async (req, res) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !verifyTelegram(req.query, botToken)) return res.status(401).send('امضای تلگرام نامعتبر یا منقضی است. دوباره تلاش کن.');
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, { tg: { id: String(req.query.id), first_name: req.query.first_name || '', last_name: req.query.last_name || '', username: req.query.username || '', photo_url: req.query.photo_url || '' }, exp: Date.now() + 5 * 60 * 1000 });
  const link = `wizchat://tg-auth?ticket=${ticket}`;
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${link}"><body style="font-family:sans-serif;text-align:center;padding-top:30vh"><p>در حال بازگشت به اپ…</p><a href="${link}">اگه باز نشد اینجا بزن</a></body>`);
});

// اگه هدر Authorization معتبر باشه => اتصال تلگرام به همین حساب؛ وگرنه ورود یا ساخت حساب
router.post('/exchange', async (req, res) => {
  try {
    const { ticket, deviceName } = req.body;
    const entry = tickets.get(ticket);
    if (!entry || entry.exp < Date.now()) return res.status(400).json({ error: 'بلیت نامعتبر یا منقضی شده؛ دوباره با تلگرام وارد شو' });
    tickets.delete(ticket); // یک‌بارمصرف
    const tg = entry.tg;
    const { createSession, signToken, userPayload } = require('./auth').helpers;

    let linkTo = null;
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
      try { linkTo = await User.findById(require('../utils/tokens').verifyAccessToken(header.slice(7)).id); } catch {}
    }

    let user = await User.findOne({ telegramId: tg.id });
    if (linkTo) {
      if (user && String(user._id) !== String(linkTo._id)) return res.status(409).json({ error: 'این تلگرام به حساب دیگه‌ای وصل شده' });
      linkTo.telegramId = tg.id;
      linkTo.telegramUsername = tg.username;
      await linkTo.save();
      return res.json({ linked: true });
    }

    let created = false;
    if (!user) {
      // حساب جدید با فیلدهای پر شده از تلگرام؛ رمز عبور تصادفی (ورود بعدی همیشه با تلگرام یا بعداً با تنظیم رمز)
      const base = (tg.username || `tg_${tg.id}`).toLowerCase().replace(/[^a-z0-9_]/g, '') || `tg_${tg.id}`;
      let username = base, n = 0;
      while (await User.findOne({ username })) username = `${base}_${++n}`;
      user = await User.create({
        username,
        displayName: `${tg.first_name} ${tg.last_name}`.trim() || tg.username || 'کاربر تلگرام',
        passwordHash: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10),
        avatarUrl: tg.photo_url || '',
        avatarUrls: tg.photo_url ? [tg.photo_url] : [],
        telegramId: tg.id,
        telegramUsername: tg.username,
      });
      created = true;
    }
    if (user.status === 'banned') return res.status(403).json({ error: 'حساب شما مسدود شده است' });
    const session = await createSession(user, { body: { deviceName: deviceName || 'دستگاه (ورود با تلگرام)' }, headers: req.headers, ip: req.ip, app: req.app });
    user.isOnline = true;
    user.lastSeen = new Date();
    await user.save();
    res.json({ token: signToken(user, session._id), user: userPayload(user), created });
  } catch (err) {
    console.error('[telegram-auth]', err);
    res.status(500).json({ error: 'خطای سرور' });
  }
});

module.exports = router;
