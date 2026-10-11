const mongoose = require('mongoose');

// پک استیکرِ قابل‌مدیریت از پنل ادمین (مثل تلگرام): هر پک چند استیکر داره، کاربر می‌تونه به حسابش اضافه کنه
const stickerPackSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 40 },
    iconUrl: { type: String, default: '' }, // آیکون تب؛ اگه نبود اولین استیکر
    stickers: [{ url: { type: String, required: true }, emoji: { type: String, default: '🙂' } }],
    published: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    isDefault: { type: Boolean, default: false }, // به همه‌ی کاربرای جدید خودکار اضافه می‌شه
  },
  { timestamps: true }
);

module.exports = mongoose.model('StickerPack', stickerPackSchema);
