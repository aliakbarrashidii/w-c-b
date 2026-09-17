const mongoose = require('mongoose');

// گزارش‌هایی که مدل روی خودِ گوشی تشخیص داده و برای ادمین فرستاده شدن. سرور فقط این بلاب
// مهروموم‌شده رو ذخیره می‌کنه؛ محتوای واقعی پیام‌های گزارش‌شده فقط با کلید خصوصی ادمین قابل خوندنه.
const encryptedReportSchema = new mongoose.Schema(
  {
    reporterDeviceId: { type: String, default: '' }, // متادیتا - نه محتوا؛ برای تشخیص گزارش‌های تکراری/اسپم
    chat: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true },
    category: { type: String, default: '' }, // مثلاً sexual_harassment - فقط برچسب دسته، نه متن پیام
    sealedBox: {
      ephemeralPublicKey: { type: String, required: true },
      nonce: { type: String, required: true },
      ciphertext: { type: String, required: true },
    },
    reviewed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('EncryptedReport', encryptedReportSchema);
