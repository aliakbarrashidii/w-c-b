const mongoose = require('mongoose');

const contactRequestSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, default: '' },
    message: { type: String, default: '' },
    resolved: { type: Boolean, default: false },
    // پیگیری توسط درخواست‌دهنده (بدون حساب/ایمیل): «بلیط» تصادفی تو دستگاهش می‌مونه و وضعیت رو با اون می‌پرسه
    ticket: { type: String, index: true, unique: true, sparse: true },
    outcome: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    responseNote: { type: String, default: '', maxlength: 200 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ContactRequest', contactRequestSchema);
