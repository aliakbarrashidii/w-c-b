const mongoose = require('mongoose');

// یه سند singleton (key='current') که کل model.json مدل Embedding+BiLSTM رو نگه می‌داره.
// کلاینت‌ها نسخه رو چک می‌کنن و اگه جدیدتر بود دانلودش می‌کنن. آپدیتش از پنل ادمین (بعداً) میاد.
const moderationModelSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'current', unique: true },
    version: { type: Number, default: 0 },
    modelJson: { type: String, default: '' }, // خروجی export_model.py، به‌صورت رشته‌ی JSON
  },
  { timestamps: true }
);

module.exports = mongoose.model('ModerationModel', moderationModelSchema);
