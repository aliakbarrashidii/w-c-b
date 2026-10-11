const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const CallLog = require('../models/CallLog');
const AdminLog = require('../models/AdminLog');
const InviteCode = require('../models/InviteCode');
const ContactRequest = require('../models/ContactRequest');
const Report = require('../models/Report');
const { requireAuth, requireRole } = require('../middleware/auth');
const { encryptText, decryptText } = require('../utils/crypto');
const { getSettings, updateSettings } = require('../utils/settings');
const ModerationModel = require('../models/ModerationModel');
const EncryptedReport = require('../models/EncryptedReport');

const rateLimit = require('express-rate-limit');
const { authenticator } = require('otplib');
const Session = require('../models/Session');
const { canActOn, clampNumber, moderatorMayViewChat } = require('../utils/adminGuards');

const router = express.Router();

// جستجوی متنیِ ادمین: ورودی رو escape می‌کنیم (قبلاً مستقیم new RegExp(q) بود: regexِ نامعتبر = خطا/کرش، و الگوهای فاجعه‌بار (ReDoS) می‌تونست
// MongoDB رو درگیر کنه)
const escapeRegex = (v) => String(v ?? '').slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// چت‌هایی که گزارشِ بازِ در حال بررسی دارن (برای حالت moderatorChatAccess = 'reported')
async function openReportedChatIds() {
  return Report.distinct('chat', { chat: { $ne: null }, status: { $in: ['pending', 'under_review'] } });
}

// فیلدهایی که حتی ادمین/ناظر نباید ببینه: رمز، راز TOTP (با اون می‌شه 2FA کاربر رو دور زد)، و توکن‌های پوش
const USER_SECRET_FIELDS = '-passwordHash -twoFactorSecret -pushTokens';

// حدس رمزِ ادمین: ۱۰ تلاش در ۱۵ دقیقه برای هر (IP، نام‌کاربری)
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${String(req.body?.username || '').toLowerCase().slice(0, 64)}`,
  message: { error: 'تلاش‌های زیاد؛ چند دقیقه‌ی دیگر دوباره امتحان کنید' },
});

async function log(adminId, action, extra = {}) {
  await AdminLog.create({ admin: adminId, action, ...extra });
}

// --- ورود مخصوص ادمین (همون مدل User با role=admin) ---
router.post('/login', adminLoginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username: username?.toLowerCase().trim() });
  if (!user || !['admin', 'moderator'].includes(user.role) || ['banned', 'deleted'].includes(user.status)) {
    return res.status(401).json({ error: 'دسترسی غیرمجاز' });
  }
  const valid = typeof password === 'string' && (await bcrypt.compare(password, user.passwordHash));
  if (!valid) return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });

  // ورود دومرحله‌ای: اگه فعاله، کد TOTP الزامیه (قبلاً این مسیر 2FA رو کاملاً نادیده می‌گرفت)
  if (user.twoFactorEnabled) {
    const code = req.body?.code;
    if (!code) return res.status(401).json({ error: 'کد ورود دومرحله‌ای لازم است', needs2fa: true });
    if (!authenticator.verify({ token: String(code), secret: user.twoFactorSecret })) return res.status(401).json({ error: 'کد نامعتبر است' });
  }
  // توکن ادمین: ۲۴ ساعت (قبلاً ۷ روز) و قابل‌ابطال با tokenVersion
  const token = jwt.sign({ id: user._id, role: user.role, tv: user.tokenVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, admin: { id: user._id, username: user.username, displayName: user.displayName, role: user.role } });
});

router.use(requireAuth, requireRole('admin', 'moderator'));

// --- ابطال توکن‌ها ---
// خروج از همه‌ی دستگاه‌های خودم (ادمین/ناظر)
router.post('/revoke-my-tokens', async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
  await Session.updateMany({ user: req.user._id }, { revoked: true });
  req.app.get('io')?.in(`user:${req.user._id}`).disconnectSockets(true);
  res.json({ ok: true });
});

// ابطال همه‌ی توکن‌ها و نشست‌های یک حساب (مثلاً حساب لو رفته) - فقط ادمین
router.post('/users/:id/revoke-tokens', requireRole('admin'), async (req, res) => {
  const user = await User.findById(req.params.id).select('_id');
  if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
  await Session.updateMany({ user: user._id }, { revoked: true });
  req.app.get('io')?.in(`user:${user._id}`).disconnectSockets(true);
  await log(req.user._id, 'revoke_tokens', { targetUser: user._id });
  res.json({ ok: true });
});

// --- آمار کلی داشبورد ---
router.get('/stats', async (req, res) => {
  const [userCount, chatCount, groupCount, messageCount, onlineCount] = await Promise.all([
    User.countDocuments(),
    Chat.countDocuments({ type: 'private' }),
    Chat.countDocuments({ type: 'group' }),
    Message.countDocuments(),
    User.countDocuments({ isOnline: true }),
  ]);
  res.json({ userCount, chatCount, groupCount, messageCount, onlineCount });
});

// --- مدیریت کاربران ---
router.get('/users', async (req, res) => {
  const { q = '', page = 1, limit = 30 } = req.query;
  const rx = q ? new RegExp(escapeRegex(q), 'i') : null;
  const filter = rx ? { $or: [{ username: rx }, { displayName: rx }, { phone: rx }] } : {};
  const users = await User.find(filter)
    .select(USER_SECRET_FIELDS)
    .sort({ createdAt: -1 })
    .skip((Math.max(1, Number(page) || 1) - 1) * Math.min(100, Number(limit) || 30))
    .limit(Math.min(100, Number(limit) || 30));
  const total = await User.countDocuments(filter);
  res.json({ users, total });
});

// ساخت کاربر دستی (چون فعلاً ثبت‌نام عمومی نداریم)
router.post('/users', async (req, res) => {
  const { username, displayName, password, role = 'user' } = req.body;
  if (!username || !displayName || !password) {
    return res.status(400).json({ error: 'همه فیلدها الزامی است' });
  }
  // ناظر فقط می‌تونه کاربر عادی بسازه؛ فقط ادمین می‌تونه ناظر/ادمین جدید بسازه (جلوگیری از ترفیع خودسرانه)
  if (req.user.role === 'moderator' && role !== 'user') {
    return res.status(403).json({ error: 'فقط ادمین می‌تواند ناظر یا ادمین جدید بسازد' });
  }
  const exists = await User.findOne({ username: username.toLowerCase().trim() });
  if (exists) return res.status(409).json({ error: 'این نام کاربری قبلاً ثبت شده است' });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({
    username: username.toLowerCase().trim(),
    displayName,
    passwordHash,
    role,
    createdByAdmin: true,
  });
  await log(req.user._id, 'create_user', { targetUser: user._id });
  res.status(201).json({ id: user._id, username: user.username });
});

router.get('/users/:id', async (req, res) => {
  const user = await User.findById(req.params.id).select(USER_SECRET_FIELDS);
  if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });
  await log(req.user._id, 'view_user_profile', { targetUser: user._id });
  res.json(user);
});

router.post('/users/:id/suspend', async (req, res) => {
  const { reason = '' } = req.body;
  const hours = clampNumber(req.body?.hours, 1, 24 * 365, 24); // قبلاً بدون سقف/اعتبارسنجی (NaN ← تاریخ نامعتبر)
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });
  if (!canActOn(req.user.role, user.role) || String(user._id) === String(req.user._id)) return res.status(403).json({ error: 'اجازه‌ی این اقدام روی این حساب را ندارید' });
  user.status = 'suspended';
  user.suspendedUntil = new Date(Date.now() + hours * 3600 * 1000);
  user.banReason = reason;
  await user.save();
  await log(req.user._id, 'suspend_user', { targetUser: user._id, note: reason });
  res.json({ ok: true });
});

router.post('/users/:id/ban', requireRole('admin'), async (req, res) => {
  const { reason = '' } = req.body;
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });
  user.status = 'banned';
  user.banReason = reason;
  await user.save();
  await log(req.user._id, 'ban_user', { targetUser: user._id, note: reason });
  res.json({ ok: true });
});

router.post('/users/:id/unban', requireRole('admin'), async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });
  user.status = 'active';
  user.suspendedUntil = null;
  user.banReason = '';
  await user.save();
  await log(req.user._id, 'unban_user', { targetUser: user._id });
  res.json({ ok: true });
});

// --- مدیریت چت‌ها و پیام‌ها (طبق ToS: قابل مشاهده برای ادمین) ---
router.get('/chats', async (req, res) => {
  const { q = '', type } = req.query;
  const page = Math.max(1, Math.floor(clampNumber(req.query.page, 1, 100000, 1)));
  const limit = Math.floor(clampNumber(req.query.limit, 1, 100, 30));
  const filter = {};
  if (type) filter.type = type;
  if (req.user.role === 'moderator' && (await getSettings()).moderatorChatAccess === 'reported') filter._id = { $in: await openReportedChatIds() };
  if (q) filter.$or = [{ title: new RegExp(escapeRegex(q), 'i') }];

  const chats = await Chat.find(filter)
    .sort({ lastActivityAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('members.user', 'username displayName avatarUrl isBot')
    .populate('lastMessage');
  const total = await Chat.countDocuments(filter);
  res.json({ chats, total });
});

router.get('/chats/:id/messages', async (req, res) => {
  const page = Math.max(1, Math.floor(clampNumber(req.query.page, 1, 100000, 1)));
  const limit = Math.floor(clampNumber(req.query.limit, 1, 200, 50));
  const chat = await Chat.findById(req.params.id).populate('members.user', 'username displayName avatarUrl isBot');
  if (!chat) return res.status(404).json({ error: 'چت یافت نشد' });
  const access = (await getSettings()).moderatorChatAccess;
  if (!moderatorMayViewChat({ role: req.user.role, access, chatId: chat._id, openReportedChatIds: access === 'reported' ? await openReportedChatIds() : [] })) {
    return res.status(403).json({ error: 'ناظر فقط به چت‌های دارای گزارش باز دسترسی دارد' });
  }

  const messages = await Message.find({ chat: chat._id })
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('sender', 'username displayName avatarUrl isBot');

  const decrypted = messages.map((m) => {
    const obj = m.toObject();
    obj.content = decryptText(obj.content);
    return obj;
  });

  await log(req.user._id, 'view_chat', { targetChat: chat._id });
  res.json({ chat, messages: decrypted.reverse() });
});

// جستجوی سراسری در محتوای پیام‌ها (برای بررسی گزارش‌ها/محتوای مشکوک)
// نکته مهم: چون content روی دیتابیس رمزنگاری‌شده، ایندکس متنی Mongo دیگر روی محتوا کار نمی‌کند.
// به همین دلیل ابتدا یک بازه محدود (بر اساس تاریخ/فلگ) واکشی می‌شود، سپس رمزگشایی و فیلتر متنی
// در سطح اپلیکیشن انجام می‌شود. برای حجم بالا، این بخش باید به یک صف پردازش پس‌زمینه منتقل شود.
router.get('/messages/search', async (req, res) => {
  const { q = '', flaggedOnly = false, page = 1, limit = 30 } = req.query;
  const filter = {};
  if (flaggedOnly === 'true') filter.flagged = true;

  const scanLimit = q ? 500 : Number(limit); // بازه‌ی اسکن بزرگ‌تر وقتی جستجوی متنی داریم
  const candidates = await Message.find(filter)
    .sort({ createdAt: -1 })
    .skip(q ? 0 : (page - 1) * limit)
    .limit(scanLimit)
    .populate('sender', 'username displayName avatarUrl isBot')
    .populate('chat', 'type title');

  let decrypted = candidates.map((m) => {
    const obj = m.toObject();
    obj.content = decryptText(obj.content);
    return obj;
  });

  if (q) {
    const needle = q.trim().toLowerCase();
    decrypted = decrypted.filter((m) => m.content?.toLowerCase().includes(needle));
    decrypted = decrypted.slice((page - 1) * limit, page * limit);
  }

  res.json(decrypted);
});

router.delete('/messages/:id', async (req, res) => {
  const message = await Message.findById(req.params.id);
  if (!message) return res.status(404).json({ error: 'پیام یافت نشد' });
  message.deletedForEveryone = true;
  message.content = '';
  await message.save();
  await require('../utils/dataCleanup').unpinMessages([message._id]);
  await log(req.user._id, 'delete_message', { targetMessage: message._id, targetChat: message.chat });
  res.json({ ok: true });
});

// --- لاگ فعالیت ادمین‌ها (برای شفافیت داخلی) ---
router.get('/logs', requireRole('admin'), async (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const logs = await AdminLog.find()
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit))
    .populate('admin', 'username displayName')
    .populate('targetUser', 'username displayName');
  res.json(logs);
});

router.get('/calls', async (req, res) => {
  const { page = 1, limit = 30 } = req.query;
  const calls = await CallLog.find()
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit))
    .populate('caller', 'username displayName')
    .populate('callee', 'username displayName');
  res.json(calls);
});

// --- کدهای دعوت (چون ثبت‌نام فقط با دعوته) ---
router.post('/invites', async (req, res) => {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const invite = await InviteCode.create({ code, createdBy: req.user._id });
  res.status(201).json(invite);
});

router.get('/invites', async (req, res) => {
  const invites = await InviteCode.find().sort({ createdAt: -1 }).limit(100).populate('usedBy', 'displayName username');
  res.json(invites);
});

// --- پیام‌های تماسِ قبل از ثبت‌نام ---
router.get('/contact-requests', async (req, res) => {
  const items = await ContactRequest.find().sort({ createdAt: -1 }).limit(100);
  res.json(items);
});

router.post('/contact-requests/:id/resolve', async (req, res) => {
  const outcome = req.body?.outcome === 'rejected' ? 'rejected' : 'approved';
  const responseNote = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 200) : '';
  await ContactRequest.findByIdAndUpdate(req.params.id, { resolved: true, outcome, responseNote });
  res.json({ ok: true });
});


// --- اطلاعیه‌ی همگانی از حساب رسمی WizChat ---
router.post('/broadcasts/preview', requireRole('admin'), async (req, res) => {
  const { countRecipients } = require('../utils/broadcast');
  res.json({ recipients: await countRecipients(sanitizeTarget(req.body?.target)) });
});

function sanitizeTarget(t = {}) {
  const arr = (x) => (Array.isArray(x) ? x.map((v) => String(v).trim().toLowerCase()).filter(Boolean).slice(0, 30) : []);
  const languages = arr(t.languages);
  const platforms = arr(t.platforms).filter((p) => ['ios', 'android', 'web'].includes(p));
  const maxAppVersion = /^\d+(\.\d+){0,3}$/.test(String(t.maxAppVersion || '').trim()) ? String(t.maxAppVersion).trim() : '';
  return { all: !languages.length && !platforms.length && !maxAppVersion, languages, platforms, maxAppVersion };
}

router.post('/broadcasts', requireRole('admin'), async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'متن اطلاعیه الزامی است' });
  if (text.length > 3000) return res.status(400).json({ error: 'متن حداکثر ۳۰۰۰ کاراکتر' });
  const kind = req.body?.kind === 'update' ? 'update' : 'info';
  const link = String(req.body?.link || '').trim();
  if (link && !/^https?:\/\//i.test(link)) return res.status(400).json({ error: 'لینک باید با http(s):// شروع شود' });
  const Broadcast = require('../models/Broadcast');
  const b = await Broadcast.create({ admin: req.user._id, text, kind, link, target: sanitizeTarget(req.body?.target) });
  await log(req.user._id, 'broadcast', { note: `اطلاعیه ${b._id}: ${text.slice(0, 80)}` });
  require('../utils/broadcast').runBroadcast(req.app, b._id).catch((e) => console.error('[broadcast]', e));
  res.status(202).json(b);
});

router.get('/broadcasts', requireRole('admin'), async (req, res) => {
  const Broadcast = require('../models/Broadcast');
  res.json(await Broadcast.find().sort({ createdAt: -1 }).limit(50));
});


// --- گزارش‌های کاربران (پیام/کاربر مشکل‌دار) ---
router.get('/reports', async (req, res) => {
  const { resolved } = req.query;
  const filter = resolved !== undefined ? { resolved: resolved === 'true' } : {};
  const items = await Report.find(filter)
    .sort({ createdAt: -1 })
    .limit(150)
    .populate('reporter', 'displayName username')
    .populate('targetUser', 'displayName username')
    .populate('targetMessage');
  res.json(items);
});

router.post('/reports/:id/resolve', async (req, res) => {
  await Report.findByIdAndUpdate(req.params.id, { resolved: true });
  res.json({ ok: true });
});

// --- تنظیمات نگهداری پیام روی سرور (فاز ۱ ارتقای امنیت) ---
// این دو تا API آماده‌ن، فقط UI پنل ادمین بعداً که نمونه‌ش رسید بهش وصل می‌شه.
router.get('/settings', async (req, res) => {
  const settings = await getSettings();
  res.json(settings);
});

router.put('/settings', requireRole('admin'), async (req, res) => { // فقط ادمین: کلید گزارش‌ها، حالت تعمیر، نگهداری پیام‌ها...
  const { messageRetentionSec, undeliveredMaxWaitSec, adminReportPublicKey, mediaRetentionSec, maxUploadSizeMb, maintenanceMode, telegramLoginEnabled } = req.body;
  const patch = {};
  if (Number.isFinite(Number(messageRetentionSec)) && Number(messageRetentionSec) > 0) {
    patch.messageRetentionSec = Number(messageRetentionSec);
  }
  if (Number.isFinite(Number(undeliveredMaxWaitSec)) && Number(undeliveredMaxWaitSec) > 0) {
    patch.undeliveredMaxWaitSec = Number(undeliveredMaxWaitSec);
  }
  if (typeof adminReportPublicKey === 'string' && adminReportPublicKey.length > 0) {
    patch.adminReportPublicKey = adminReportPublicKey;
  }
  if (mediaRetentionSec && typeof mediaRetentionSec === 'object') {
    const allowed = ['image', 'video', 'voice', 'video_note', 'file'];
    const clean = {};
    for (const key of allowed) {
      const v = mediaRetentionSec[key];
      if (v === null || v === '' || v === undefined) clean[key] = null; // یعنی «از پیش‌فرض استفاده کن»
      else if (Number.isFinite(Number(v)) && Number(v) > 0) clean[key] = Number(v);
    }
    patch.mediaRetentionSec = clean;
  }
  if (Number.isFinite(Number(maxUploadSizeMb)) && Number(maxUploadSizeMb) > 0) {
    patch.maxUploadSizeMb = Number(maxUploadSizeMb);
  }
  if (maintenanceMode && typeof maintenanceMode === 'object') {
    if (typeof maintenanceMode.enabled === 'boolean') patch['maintenanceMode.enabled'] = maintenanceMode.enabled;
    if (typeof maintenanceMode.message === 'string' && maintenanceMode.message.trim()) {
      patch['maintenanceMode.message'] = maintenanceMode.message;
    }
  }
  if (typeof telegramLoginEnabled === 'boolean') patch.telegramLoginEnabled = telegramLoginEnabled;
  if (['all', 'reported'].includes(req.body.moderatorChatAccess)) patch.moderatorChatAccess = req.body.moderatorChatAccess;
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'مقدار معتبری ارسال نشده' });
  const settings = await updateSettings(patch);
  await log(req.user.id, 'update_settings', { note: JSON.stringify(patch) });
  res.json(settings);
});

// --- مدل تشخیص محتوا (فاز ۳) - آپلود نسخه‌ی جدید از پنل ادمین، به‌ازای هر زبون جدا (فاز ۸) ---
router.post('/moderation/model', requireRole('admin'), async (req, res) => { // آپلود مدل نظارت = اثر روی همه‌ی کاربران
  const { modelJson, lang } = req.body;
  const langKey = (lang || 'fa').toLowerCase();
  if (!modelJson) return res.status(400).json({ error: 'modelJson ارسال نشده' });
  try {
    JSON.parse(typeof modelJson === 'string' ? modelJson : JSON.stringify(modelJson));
  } catch {
    return res.status(400).json({ error: 'modelJson معتبر نیست' });
  }
  const jsonString = typeof modelJson === 'string' ? modelJson : JSON.stringify(modelJson);
  // ساختار مدل رو چک می‌کنیم؛ فایل اشتباه (مثلاً خروجی خامِ Keras) نباید کلاینت‌ها رو خراب کنه
  const parsed = JSON.parse(jsonString);
  const required = ['labels', 'maxLen', 'word2idx', 'embedding', 'lstmUnits', 'forward', 'backward', 'dense1', 'dense2'];
  const missing = required.filter((k) => parsed[k] === undefined);
  if (missing.length) return res.status(400).json({ error: `فایل مدل معتبر نیست؛ فیلدهای ناقص: ${missing.join('، ')} (باید خروجی export_model.py باشه)` });
  if (!Array.isArray(parsed.labels) || !parsed.labels.includes('normal')) return res.status(400).json({ error: 'برچسب «normal» باید بین کلاس‌های مدل باشه' });
  const current = await ModerationModel.findOne({ key: langKey });
  const nextVersion = (current?.version || 0) + 1;
  await ModerationModel.findOneAndUpdate(
    { key: langKey },
    { version: nextVersion, modelJson: jsonString, labels: parsed.labels, sizeBytes: Buffer.byteLength(jsonString) },
    { upsert: true }
  );
  await updateSettings({ contentModelVersion: String(nextVersion) });
  await log(req.user.id, 'update_settings', { note: `moderation model [${langKey}] -> v${nextVersion}` });
  res.json({ ok: true, version: nextVersion, lang: langKey, labels: parsed.labels });
});

// لیست مدل‌های آپلودشده به تفکیک زبان (برای صفحه‌ی «مدل‌های AI» تو پنل)
router.get('/moderation/models', async (req, res) => {
  const docs = await ModerationModel.find({}).select('key version labels sizeBytes updatedAt');
  res.json(docs.map((d) => ({ lang: d.key, version: d.version, labels: d.labels, sizeBytes: d.sizeBytes, updatedAt: d.updatedAt })));
});

// حذف مدلِ یه زبان => اون زبان دوباره به مدل فارسی فال‌بک می‌کنه (فارسی رو نمی‌شه حذف کرد چون فال‌بک همه‌ی زبان‌هاست)
router.delete('/moderation/model/:lang', requireRole('admin'), async (req, res) => {
  const lang = req.params.lang.toLowerCase();
  if (lang === 'fa') return res.status(400).json({ error: 'مدل فارسی فال‌بک بقیه‌ی زبان‌هاست و حذف نمی‌شه؛ می‌تونی نسخه‌ی جدید جایگزینش کنی' });
  await ModerationModel.deleteOne({ key: lang });
  await updateSettings({ contentModelVersion: String(Date.now()) });
  await log(req.user.id, 'update_settings', { note: `moderation model [${lang}] deleted` });
  res.json({ ok: true });
});

// --- گزارش‌های رمزشده‌ی خودکار (فاز ۳) - محتوای واقعی فقط با کلید خصوصی ادمین قابل خوندنه؛
// این‌جا فقط لیستشون می‌کنیم، رمزگشایی سمت ادمین (بعداً که پنل رو فرستادی وصلش می‌کنم) اتفاق میفته ---
router.get('/reports/encrypted', async (req, res) => {
  const items = await EncryptedReport.find({})
    .sort({ createdAt: -1 })
    .limit(150)
    .populate('chat', 'type');
  res.json(items);
});

// ---- ربات‌ها: سیاست + فهرست + غیرفعال‌سازی ----
router.get('/bots', async (req, res) => {
  const Bot = require('../models/Bot');
  const bots = await Bot.find({}).sort({ createdAt: -1 }).limit(200).populate('user', 'username displayName').populate('owner', 'username displayName');
  res.json(bots.map((b) => ({ id: b._id, username: b.user?.username, name: b.user?.displayName, owner: b.owner?.displayName, type: b.type, active: b.active, disabledByAdmin: b.disabledByAdmin, messages: b.stats?.messages || 0, lastActiveAt: b.stats?.lastActiveAt })));
});
router.post('/bots/:id/disable', async (req, res) => {
  const Bot = require('../models/Bot');
  await Bot.updateOne({ _id: req.params.id }, { disabledByAdmin: req.body.disabled !== false });
  await AdminLog.create({ admin: req.user.id, action: 'update_settings', note: `bot ${req.params.id} disabled=${req.body.disabled !== false}` }).catch(() => {});
  res.json({ ok: true });
});
router.get('/bot-policy', async (req, res) => res.json(await require('../utils/botEngine').getBotPolicy()));
router.put('/bot-policy', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const clean = {
    allowUserBots: b.allowUserBots !== false, agentEnabled: b.agentEnabled !== false, allowHttpEndpoints: b.allowHttpEndpoints === true,
    maxBotsPerUser: Math.max(0, Math.min(Number(b.maxBotsPerUser) || 0, 50)), agentRatePerMinPerUser: Math.max(1, Math.min(Number(b.agentRatePerMinPerUser) || 6, 60)), agentDailyPerBot: Math.max(1, Math.min(Number(b.agentDailyPerBot) || 500, 100000)),
  };
  await updateSettings({ botPolicy: clean });
  res.json(await require('../utils/botEngine').getBotPolicy());
});

router.use('/moderation', require('./adminModeration'));
router.use('/sticker-packs', require('./stickers').adminRouter);

module.exports = router;
