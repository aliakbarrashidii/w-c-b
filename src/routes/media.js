const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const { getSettings } = require('../utils/settings');
const { safeUploadName } = require('../utils/uploadName');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, safeUploadName(file.originalname)),
});

// ۵۰۰ مگابایت سقفِ مطلق (ضدسوءاستفاده) - مقدار واقعیِ قابل‌تنظیم از ادمین رو میدل‌ور زیر چک می‌کنه،
// چون multer نمی‌تونه محدودیتش رو بعد از راه‌اندازیِ سرور به‌صورت پویا عوض کنه
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// قبل از خودِ آپلود، حجم رو با تنظیمِ فعلیِ ادمین (Settings.maxUploadSizeMb) مقایسه می‌کنه -
// این‌طوری ادمین می‌تونه بدون ری‌استارت سرور محدودیت رو عوض کنه
async function checkUploadSizeLimit(req, res, next) {
  const settings = await getSettings();
  const maxBytes = (settings.maxUploadSizeMb || 50) * 1024 * 1024;
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > maxBytes + 1024) {
    return res.status(413).json({ error: `حجم فایل بیش از حد مجازه (حداکثر ${settings.maxUploadSizeMb} مگابایت)` });
  }
  next();
}

// آپلود عکس/ویس/فایل — خروجی یه URL که مستقیم در mediaUrl پیام استفاده می‌شه
router.post('/upload', requireAuth, checkUploadSizeLimit, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایلی ارسال نشده است' });
  const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url, fileName: req.file.originalname, fileSizeBytes: req.file.size });
});

module.exports = router;
