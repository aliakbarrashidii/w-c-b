const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const ModerationModel = require('../models/ModerationModel');
const EncryptedReport = require('../models/EncryptedReport');
const { getSettings } = require('../utils/settings');

const { validateSealedBox } = require('../utils/sealedBoxValidate');
const { resolveRouting } = require('../utils/staffPolicy');
const { afterReportCreated } = require('../utils/reportHooks');
const { getPolicy } = require('../utils/moderationPolicy');
const { OPEN } = require('../utils/caseRouting');

const DEFAULT_LANG = 'fa';
const HOURLY_LIMIT = 40; // گزارش رمزشده در ساعت برای هر کاربر

// بدونِ فال‌بک: مدلِ یک زبان روی زبانِ دیگر گزارشِ اشتباه می‌سازد؛ «نبودِ مدل» از «مدلِ نامربوط» بهتر است.
// فقط وقتی lang اصلاً داده نشده، فارسی (پیش‌فرضِ قدیمیِ کلاینت‌ها) برگردانده می‌شود.
async function findModelForLang(lang, allowFallback = false) {
  const wanted = String(lang || DEFAULT_LANG).toLowerCase().slice(0, 12);
  const exact = await ModerationModel.findOne({ key: wanted });
  if (exact || !allowFallback) return exact;
  return ModerationModel.findOne({ key: DEFAULT_LANG });
}

// کلاینت اول این رو چک می‌کنه (سبک، بدون دانلود ۵۰۰+ کیلوبایت) تا ببینه آپدیتی هست یا نه.
// ?lang=xx مدلِ همون زبون رو می‌خواد؛ اگه نباشه lang:null (کلاینت باید «بدونِ مدل» رفتار کنه، نه فارسی).
router.get('/model/version', requireAuth, async (req, res) => {
  const current = await findModelForLang(req.query.lang);
  res.json({ version: current?.version || 0, lang: current?.key || null });
});

// فقط وقتی نسخه‌ی جدیدتری لازم داره کل مدل رو می‌گیره
router.get('/model', requireAuth, async (req, res) => {
  const current = await findModelForLang(req.query.lang);
  if (!current || !current.modelJson) return res.status(404).json({ error: 'برای این زبان هنوز مدلی آپلود نشده' });
  res.json({ version: current.version, lang: current.key, model: JSON.parse(current.modelJson) });
});

// کلیدهای عمومیِ گیرنده‌های گزارش: publicKey = مدیر اصلی (ردیف ۰)، recipients = ردیف‌های ۰ تا پایین‌ترین ردیفِ مسیریابی که کلید دارند.
// هر کاربر می‌تواند بخواند (فقط عمومی است).
router.get('/admin-key', requireAuth, async (req, res) => {
  const settings = await getSettings();
  if (!settings.adminReportPublicKey) return res.status(404).json({ error: 'کلید ادمین هنوز تنظیم نشده' });
  const routing = resolveRouting(settings.moderationRouting);
  const lowest = Math.max(routing.initialTier, ...Object.values(routing.byCategory), 0);
  const keys = settings.moderationTierKeys || {};
  const recipients = [{ level: 0, version: keys['0']?.version || 1, publicKey: settings.adminReportPublicKey }];
  for (let l = 1; l <= lowest; l += 1) if (keys[String(l)]?.publicKey) recipients.push({ level: l, version: keys[String(l)].version || 1, publicKey: keys[String(l)].publicKey });
  res.json({ publicKey: settings.adminReportPublicKey, recipients });
});

// «قبلاً گزارش شده؟» — اپ قبلِ رمزکردن/ارسال می‌پرسد تا در گروه، گوشیِ همه‌ی اعضا کارِ تکراری نکند (فقط برای اعضای همان چت)
router.get('/reports/exists', requireAuth, async (req, res) => {
  const { chatId, accusedUserId, category } = req.query;
  if (![chatId, accusedUserId].every((v) => mongoose.isValidObjectId(v))) return res.json({ exists: false });
  const chat = await require('../models/Chat').findById(chatId).select('members');
  if (!chat || !chat.members.some((m) => String(m.user) === String(req.user._id))) return res.json({ exists: false });
  const dedupeMin = (await getPolicy()).dedupeMinutes;
  if (!(dedupeMin > 0)) return res.json({ exists: false });
  const found = await EncryptedReport.exists({ chat: chatId, accusedUser: accusedUserId, category: String(category || '').slice(0, 40), status: { $in: OPEN }, createdAt: { $gte: new Date(Date.now() - dedupeMin * 60000) } });
  res.json({ exists: !!found });
});

// ثبت گزارش رمزشده. محتوا ادعای کلاینت است و سرور راستی‌آزمایی نمی‌کند؛ فقط ساختار/عضویت/نرخ را می‌سنجد و گزارش‌دهنده را ثبت می‌کند.
router.post('/reports/encrypted', requireAuth, async (req, res) => {
  const { chatId, category, sealedBox, reporterDeviceId, accusedUserId } = req.body;
  if (!chatId || !mongoose.isValidObjectId(chatId)) return res.status(400).json({ error: 'اطلاعات گزارش ناقص است' });
  const v = validateSealedBox(sealedBox);
  if (v.error) return res.status(400).json({ error: v.error });
  const Chat = require('../models/Chat');
  const chat = await Chat.findById(chatId).select('members');
  if (!chat || !chat.members.some((m) => String(m.user) === String(req.user._id))) return res.status(403).json({ error: 'عضو این چت نیستی' });
  const recent = await EncryptedReport.countDocuments({ reporter: req.user._id, createdAt: { $gte: new Date(Date.now() - 3600 * 1000) } });
  if (recent >= HOURLY_LIMIT) return res.status(429).json({ error: 'گزارش‌های زیاد؛ کمی بعد دوباره امتحان کنید' });
  // فقط گوشیِ «طرفِ مقابل» گزارش می‌دهد؛ خودِ فرستنده هرگز علیه خودش گزارش نمی‌دهد (اپ پیام‌های ارسالی را اصلاً گزارش نمی‌کند)
  if (accusedUserId && String(accusedUserId) === String(req.user._id)) return res.status(400).json({ error: 'متهم نمی‌تواند خودِ گزارش‌دهنده باشد' });
  const accusedOk = accusedUserId && mongoose.isValidObjectId(accusedUserId) && chat.members.some((m) => String(m.user) === String(accusedUserId));
  // «یک گزارش»: گزارش‌های تکراریِ همان چت/متهم/دسته در بازه‌ی dedupeMinutes (مثلاً گوشیِ بقیه‌ی اعضای گروه) به همان پرونده ملحق می‌شوند
  if (accusedOk) {
    const dedupeMin = (await getPolicy()).dedupeMinutes;
    if (dedupeMin > 0) {
      const dup = await EncryptedReport.findOneAndUpdate({ chat: chatId, accusedUser: accusedUserId, category: String(category || '').slice(0, 40), status: { $in: OPEN }, createdAt: { $gte: new Date(Date.now() - dedupeMin * 60000) } }, { $inc: { dupCount: 1 } });
      if (dup) return res.json({ ok: true, duplicate: true });
    }
  }
  const rec = await EncryptedReport.create({ chat: chatId, category: String(category || '').slice(0, 40), sealedBox: v.value, reporterDeviceId: String(reporterDeviceId || '').slice(0, 80), reporter: req.user._id, accusedUser: accusedOk ? accusedUserId : null });
  if (accusedOk) await require('../models/User').updateOne({ _id: accusedUserId }, { $inc: { 'moderation.reportsAgainst': 1 } });
  await afterReportCreated(rec, accusedOk ? accusedUserId : null);
  res.json({ ok: true });
});

module.exports = router;
module.exports.findModelForLang = findModelForLang;
