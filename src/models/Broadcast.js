const mongoose = require('mongoose');

// اطلاعیه‌ی همگانی از طرف حساب رسمی WizChat. متن در لحظه‌ی ارسال تو چتِ سیستمیِ هر گیرنده کپی می‌شه؛
// این سند فقط سابقه‌ی ارسال (متن، هدف، تعداد) رو برای ادمین نگه می‌داره.
const broadcastSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, maxlength: 3000 },
    // هدف: همه | زبان‌های مشخص | نسخه‌ی اپ قدیمی‌تر از X | پلتفرم
    target: {
      all: { type: Boolean, default: true },
      languages: [{ type: String }],
      platforms: [{ type: String }],
      maxAppVersion: { type: String, default: '' }, // فقط کاربران با نسخه‌ی کمتر از این (برای «لطفاً آپدیت کن»)
    },
    // نوع: info | update (دکمه‌ی بروزرسانی با لینک)
    kind: { type: String, enum: ['info', 'update'], default: 'info' },
    link: { type: String, default: '' },
    recipients: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    status: { type: String, enum: ['sending', 'done'], default: 'sending' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Broadcast', broadcastSchema);
