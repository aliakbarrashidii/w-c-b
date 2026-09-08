const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const WALLPAPER_DIR = path.join(__dirname, '..', '..', 'wallpapers');
const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

// لیست همه‌ی عکس‌هایی که تو پوشه‌ی backend/wallpapers/ هست — همین که فایل جدید اضافه کنی این لیست خودکار آپدیت می‌شه
router.get('/', (req, res) => {
  if (!fs.existsSync(WALLPAPER_DIR)) return res.json([]);
  const files = fs
    .readdirSync(WALLPAPER_DIR)
    .filter((f) => ALLOWED_EXT.includes(path.extname(f).toLowerCase()));
  const list = files.map((f) => ({
    name: f,
    url: `${req.protocol}://${req.get('host')}/wallpapers/${encodeURIComponent(f)}`,
  }));
  res.json(list);
});

module.exports = router;
