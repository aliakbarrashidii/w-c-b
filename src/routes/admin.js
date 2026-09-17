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

const router = express.Router();

async function log(adminId, action, extra = {}) {
  await AdminLog.create({ admin: adminId, action, ...extra });
}

// --- ورود مخصوص ادمین (همون مدل User با role=admin) ---
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username: username?.toLowerCase().trim() });
  if (!user || !['admin', 'moderator'].includes(user.role)) {
    return res.status(401).json({ error: 'دسترسی غیرمجاز' });
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });

  const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, admin: { id: user._id, username: user.username, displayName: user.displayName, role: user.role } });
});

router.use(requireAuth, requireRole('admin', 'moderator'));

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
  const filter = q ? { $or: [{ username: new RegExp(q, 'i') }, { displayName: new RegExp(q, 'i') }, { phone: new RegExp(q, 'i') }] } : {};
  const users = await User.find(filter)
    .select('-passwordHash')
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit));
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
  const user = await User.findById(req.params.id).select('-passwordHash');
  if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });
  await log(req.user._id, 'view_user_profile', { targetUser: user._id });
  res.json(user);
});

router.post('/users/:id/suspend', async (req, res) => {
  const { hours = 24, reason = '' } = req.body;
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });
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
  const { q = '', type, page = 1, limit = 30 } = req.query;
  const filter = {};
  if (type) filter.type = type;
  if (q) filter.$or = [{ title: new RegExp(q, 'i') }];

  const chats = await Chat.find(filter)
    .sort({ lastActivityAt: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit))
    .populate('members.user', 'username displayName avatarUrl')
    .populate('lastMessage');
  const total = await Chat.countDocuments(filter);
  res.json({ chats, total });
});

router.get('/chats/:id/messages', async (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const chat = await Chat.findById(req.params.id).populate('members.user', 'username displayName avatarUrl');
  if (!chat) return res.status(404).json({ error: 'چت یافت نشد' });

  const messages = await Message.find({ chat: chat._id })
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit))
    .populate('sender', 'username displayName avatarUrl');

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
    .populate('sender', 'username displayName avatarUrl')
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
  await ContactRequest.findByIdAndUpdate(req.params.id, { resolved: true });
  res.json({ ok: true });
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

router.put('/settings', async (req, res) => {
  const { messageRetentionSec, undeliveredMaxWaitSec, adminReportPublicKey } = req.body;
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
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'مقدار معتبری ارسال نشده' });
  const settings = await updateSettings(patch);
  await log(req.user.id, 'update_settings', { note: JSON.stringify(patch) });
  res.json(settings);
});

// --- مدل تشخیص محتوا (فاز ۳) - آپلود نسخه‌ی جدید از پنل ادمین (بعداً UI‌اش وصل می‌شه) ---
router.post('/moderation/model', async (req, res) => {
  const { modelJson } = req.body;
  if (!modelJson) return res.status(400).json({ error: 'modelJson ارسال نشده' });
  try {
    JSON.parse(typeof modelJson === 'string' ? modelJson : JSON.stringify(modelJson));
  } catch {
    return res.status(400).json({ error: 'modelJson معتبر نیست' });
  }
  const jsonString = typeof modelJson === 'string' ? modelJson : JSON.stringify(modelJson);
  const current = await ModerationModel.findOne({ key: 'current' });
  const nextVersion = (current?.version || 0) + 1;
  await ModerationModel.findOneAndUpdate(
    { key: 'current' },
    { version: nextVersion, modelJson: jsonString },
    { upsert: true }
  );
  await updateSettings({ contentModelVersion: String(nextVersion) });
  await log(req.user.id, 'update_settings', { note: `moderation model -> v${nextVersion}` });
  res.json({ ok: true, version: nextVersion });
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

module.exports = router;
