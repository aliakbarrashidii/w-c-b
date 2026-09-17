const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const ModerationModel = require('../models/ModerationModel');
const EncryptedReport = require('../models/EncryptedReport');
const { getSettings } = require('../utils/settings');

// کلاینت اول این رو چک می‌کنه (سبک، بدون دانلود ۵۰۰+ کیلوبایت) تا ببینه آپدیتی هست یا نه
router.get('/model/version', requireAuth, async (req, res) => {
  const current = await ModerationModel.findOne({ key: 'current' }).select('version');
  res.json({ version: current?.version || 0 });
});

// فقط وقتی نسخه‌ی جدیدتری لازم داره کل مدل رو می‌گیره
router.get('/model', requireAuth, async (req, res) => {
  const current = await ModerationModel.findOne({ key: 'current' });
  if (!current || !current.modelJson) return res.status(404).json({ error: 'هنوز مدلی روی سرور آپلود نشده' });
  res.json({ version: current.version, model: JSON.parse(current.modelJson) });
});

// کلید عمومیِ ادمین برای مهروموم‌کردن گزارش‌ها - هر کاربر باید بتونه این رو بخونه (فقط عمومیه، خطری نداره)
router.get('/admin-key', requireAuth, async (req, res) => {
  const settings = await getSettings();
  if (!settings.adminReportPublicKey) return res.status(404).json({ error: 'کلید ادمین هنوز تنظیم نشده' });
  res.json({ publicKey: settings.adminReportPublicKey });
});

// ثبت یه گزارش رمزشده (محتوای واقعی فقط داخل sealedBox و فقط با کلید خصوصی ادمین قابل‌خوندنه)
router.post('/reports/encrypted', requireAuth, async (req, res) => {
  const { chatId, category, sealedBox, reporterDeviceId } = req.body;
  if (!chatId || !sealedBox?.ephemeralPublicKey || !sealedBox?.nonce || !sealedBox?.ciphertext) {
    return res.status(400).json({ error: 'اطلاعات گزارش ناقص است' });
  }
  await EncryptedReport.create({ chat: chatId, category: category || '', sealedBox, reporterDeviceId: reporterDeviceId || '' });
  res.json({ ok: true });
});

module.exports = router;
