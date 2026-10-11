const mongoose = require('mongoose');

// یه سند به‌ازای هر زبان (key = کد زبان مثل 'fa'، 'en') که model.json مخصوصِ همون زبون رو نگه
// می‌داره. فعلاً فقط فارسی (fa) واقعاً train شده؛ بقیه‌ی زبان‌ها موقتاً به همون فارسی فال‌بک می‌کنن
// تا مدل‌های اختصاصیِ خودشون هم (از پنل ادمین) آپلود بشه. کلاینت‌ها نسخه رو چک می‌کنن و اگه
// جدیدتر بود دانلودش می‌کنن.
const moderationModelSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true }, // کد زبان، مثلاً 'fa'
    version: { type: Number, default: 0 },
    modelJson: { type: String, default: '' }, // خروجی export_model.py، به‌صورت رشته‌ی JSON
    labels: [{ type: String }], // برچسب‌های کلاس‌های مدل (برای نمایش تو پنل و ساخت سیاست نظارت)
    sizeBytes: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ModerationModel', moderationModelSchema);
