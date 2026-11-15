const mongoose = require('mongoose');

// گزارش‌هایی که مدل روی خودِ گوشی تشخیص داده و برای ادمین فرستاده شدن. سرور فقط این بلاب
// مهروموم‌شده رو ذخیره می‌کنه؛ محتوای واقعی پیام‌های گزارش‌شده فقط با کلید خصوصی ادمین قابل خوندنه.
const encryptedReportSchema = new mongoose.Schema(
  {
    reporterDeviceId: { type: String, default: '' }, // متادیتا - نه محتوا؛ برای تشخیص گزارش‌های تکراری/اسپم
    chat: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true },
    category: { type: String, default: '' }, // مثلاً sexual_harassment - فقط برچسب دسته، نه متن پیام
    // v1: یک گیرنده (مدیر اصلی) | v2: چندگیرنده، keys[{level,version,ephemeralPublicKey,nonce,ciphertext}] (ردیفِ ۰ الزامی)
    sealedBox: {
      v: { type: Number, default: 1 },
      ephemeralPublicKey: { type: String, default: '' },
      nonce: { type: String, default: '' },
      ciphertext: { type: String, default: '' },
      keys: [{ _id: false, level: Number, version: { type: Number, default: 1 }, ephemeralPublicKey: String, nonce: String, ciphertext: String }],
    },
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // به ناظرهای پایین نشان داده نمی‌شود
    dupCount: { type: Number, default: 0 }, // گزارش‌های تکراریِ دستگاه‌های دیگر که به همین پرونده ملحق شدند
    reviewed: { type: Boolean, default: false },
    // متادیتا (نه محتوا) تا بشه به پرونده‌ی کاربر وصلش کرد؛ فقط وقتی معتبره که عضو همون چت باشه
    accusedUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ['pending', 'under_review', 'confirmed', 'dismissed'], default: 'pending' },
    decision: { type: mongoose.Schema.Types.Mixed, default: null },
    // مسیریابیِ پرونده بین ردیف‌های ادمین
    tier: { type: Number, default: 0 },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    assignedAt: { type: Date, default: null },
    dueAt: { type: Date, default: null },
    escalations: [{ from: Number, to: Number, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, at: { type: Date, default: Date.now }, reason: { type: String, default: '' }, auto: { type: Boolean, default: false } }],
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('EncryptedReport', encryptedReportSchema);
