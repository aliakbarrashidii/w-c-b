const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    deviceName: { type: String, default: '' }, // خالی = ناشناس (کلاینت قدیمی)؛ نمایش «ناشناس» با ترجمه سمت اپ است
    deviceId: { type: String, default: '', index: true }, // شناسه‌ی پایدار نصب اپ
    platform: { type: String, default: '' },
    osVersion: { type: String, default: '' },
    appVersion: { type: String, default: '' },
    restrictedUntil: { type: Date, default: null }, // تا این زمان نشست «محدود» است (سیاست ۲۴ساعته‌ی دستگاه تازه)
    confirmedAt: { type: Date, default: null },     // صاحب حساب از دستگاه قدیمی تأیید کرد
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
    lastActiveAt: { type: Date, default: Date.now },
    revoked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Session', sessionSchema);
