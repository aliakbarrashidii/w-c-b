const mongoose = require('mongoose');

// هر دستگاهِ هر کاربر یه Identity Key مستقل داره. سرور فقط کلیدهای عمومی رو نگه می‌داره؛
// کلید خصوصی هیچ‌وقت از خودِ دستگاه خارج نمی‌شه (تو SecureStore/Keystore/Keychain می‌مونه).
// این مدل معادل «Prekey Bundle» پروتکل سیگنال برای X3DH هست.
const deviceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    deviceId: { type: String, required: true }, // شناسه‌ی پایدار دستگاه (نصب اپ) - نه سشن توکن
    platform: { type: String, enum: ['ios', 'android', 'web'], default: 'android' },
    // Identity Key: کلید بلندمدت X25519 این دستگاه (base64) - فقط برای DH/X3DH
    identityKeyPub: { type: String, required: true },
    // یه کلید بلندمدت جدا و Ed25519 فقط برای امضا (X25519 خودش نمی‌تونه امضا کنه)
    identitySignKeyPub: { type: String, required: true },
    // Signed Prekey: میان‌مدت، هر چند وقت یک‌بار عوض می‌شه، با Identity Key امضا شده
    signedPrekeyId: { type: Number, required: true },
    signedPrekeyPub: { type: String, required: true },
    signedPrekeySig: { type: String, required: true }, // امضای Identity Key روی signedPrekeyPub
    // One-Time Prekeys: هرکدوم فقط یه‌بار مصرف می‌شه (وقتی طرف مقابل باهاش X3DH می‌کنه حذف می‌شه)
    oneTimePrekeys: [
      {
        keyId: Number,
        pub: String,
      },
    ],
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

deviceSchema.index({ user: 1, deviceId: 1 }, { unique: true });

module.exports = mongoose.model('Device', deviceSchema);
