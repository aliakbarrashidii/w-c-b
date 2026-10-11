const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const ModerationModel = require('../models/ModerationModel');
const EncryptedReport = require('../models/EncryptedReport');
const { getSettings } = require('../utils/settings');

const FALLBACK_LANG = 'fa'; // تنها زبونی که فعلاً واقعاً train شده

async function findModelForLang(lang) {
  const wanted = (lang || FALLBACK_LANG).toLowerCase();
  return (await ModerationModel.findOne({ key: wanted })) || (await ModerationModel.findOne({ key: FALLBACK_LANG }));
}

// کلاینت اول این رو چک می‌کنه (سبک، بدون دانلود ۵۰۰+ کیلوبایت) تا ببینه آپدیتی هست یا نه.
// ?lang=xx مدلِ همون زبون رو می‌خواد؛ اگه هنوز train نشده باشه، فال‌بک به فارسی.
router.get('/model/version', requireAuth, async (req, res) => {
  const current = await findModelForLang(req.query.lang);
  res.json({ version: current?.version || 0, lang: current?.key || FALLBACK_LANG });
});

// فقط وقتی نسخه‌ی جدیدتری لازم داره کل مدل رو می‌گیره
router.get('/model', requireAuth, async (req, res) => {
  const current = await findModelForLang(req.query.lang);
  if (!current || !current.modelJson) return res.status(404).json({ error: 'هنوز مدلی روی سرور آپلود نشده' });
  res.json({ version: current.version, lang: current.key, model: JSON.parse(current.modelJson) });
});

// کلید عمومیِ ادمین برای مهروموم‌کردن گزارش‌ها - هر کاربر باید بتونه این رو بخونه (فقط عمومیه، خطری نداره)
router.get('/admin-key', requireAuth, async (req, res) => {
  const settings = await getSettings();
  if (!settings.adminReportPublicKey) return res.status(404).json({ error: 'کلید ادمین هنوز تنظیم نشده' });
  res.json({ publicKey: settings.adminReportPublicKey });
});

// ثبت یه گزارش رمزشده (محتوای واقعی فقط داخل sealedBox و فقط با کلید خصوصی ادمین قابل‌خوندنه)
router.post('/reports/encrypted', requireAuth, async (req, res) => {
  const { chatId, category, sealedBox, reporterDeviceId, accusedUserId } = req.body;
  if (!chatId || !sealedBox?.ephemeralPublicKey || !sealedBox?.nonce || !sealedBox?.ciphertext) {
    return res.status(400).json({ error: 'اطلاعات گزارش ناقص است' });
  }
  // متهم فقط وقتی ثبت می‌شه که واقعاً عضو همون چت (و خودِ گزارش‌دهنده نیست) باشه - جلوی جعلِ پرونده علیه دیگران
  const Chat = require('../models/Chat');
  const chat = await Chat.findById(chatId).select('members');
  if (!chat || !chat.members.some((m) => String(m.user) === String(req.user._id))) return res.status(403).json({ error: 'عضو این چت نیستی' });
  const accusedOk = accusedUserId && String(accusedUserId) !== String(req.user._id) && chat.members.some((m) => String(m.user) === String(accusedUserId));
  await EncryptedReport.create({ chat: chatId, category: category || '', sealedBox, reporterDeviceId: reporterDeviceId || '', accusedUser: accusedOk ? accusedUserId : null });
  if (accusedOk) await require('../models/User').updateOne({ _id: accusedUserId }, { $inc: { 'moderation.reportsAgainst': 1 } });
  res.json({ ok: true });
});

module.exports = router;
