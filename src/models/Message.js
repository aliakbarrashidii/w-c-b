const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    chat: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true, index: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    clientId: { type: String, default: null }, // شناسه‌ی سمت کلاینت برای جلوگیری از پیام تکراری (Optimistic UI)
    type: { type: String, enum: ['text', 'image', 'video', 'video_note', 'file', 'voice', 'call_log'], default: 'text' },
    content: { type: String, default: '' },
    mediaUrl: { type: String, default: '' },
    mediaMeta: {
      width: Number,
      height: Number,
      durationSec: Number,
      fileName: String,
      fileSizeBytes: Number,
    },
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
    mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    forwardedFrom: {
      originalSender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      originalChat: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', default: null },
    },
    reactions: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        emoji: { type: String },
      },
    ],
    editedAt: { type: Date, default: null },
    deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    deletedForEveryone: { type: Boolean, default: false },
    readBy: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        readAt: { type: Date, default: Date.now },
      },
    ],
    deliveredTo: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        deliveredAt: { type: Date, default: Date.now },
      },
    ],
    flagged: { type: Boolean, default: false },
    flagReason: { type: String, default: '' },
    expiresAt: { type: Date, default: null }, // برای خودتخریب چت‌های مخفی
    // وقتی پیام به همه‌ی اعضای مقصد (به‌جز فرستنده) تحویل داده شد، این ست می‌شه.
    // تا وقتی null باشه یعنی «نرسیده» و از سقف نگهداری معمولی مستثناست (فقط سقف جداگانه‌ی
    // «نرسیده‌ی خیلی قدیمی» روش اعمال می‌شه) — طبق تنظیمات پنل ادمین (models/Settings.js)
    fullyDeliveredAt: { type: Date, default: null, index: true },
    // پیام‌های چت خصوصی/مخفی که با موتور X3DH+Double Ratchet (mobile-app/src/crypto) رمز شدن:
    // سرور اصلاً نمی‌تونه بازش کنه - content این پیام‌ها همیشه خالیه، محتوای واقعی همینجاست
    // (یه سایفرتکست جدا به‌ازای هر دستگاهِ گیرنده، چون هر دستگاه سشن رمزنگاری خودش رو داره)
    e2e: {
      senderDeviceId: { type: String, default: null },
      payloads: [
        {
          deviceId: String,
          header: { dh: String, pn: Number, n: Number },
          nonce: String,
          ciphertext: String,
          // فقط برای اولین پیامی که یه دستگاه جدید می‌فرسته - بسته‌ی هندشیک X3DH که گیرنده باهاش سشن می‌سازه
          initialMessage: {
            identityKeyPub: String,
            ephemeralKeyPub: String,
            usedSignedPrekeyId: Number,
            usedOneTimePrekeyId: Number,
          },
        },
      ],
    },
  },
  { timestamps: true }
);

messageSchema.index({ chat: 1, createdAt: -1 });
messageSchema.index({ chat: 1, sender: 1, clientId: 1 });
// توجه: content روی دیتابیس رمزنگاری‌شده ذخیره می‌شود (utils/crypto.js)،
// بنابراین دیگر ایندکس متنی روی آن معنا ندارد؛ جستجو در سطح اپلیکیشن پس از رمزگشایی انجام می‌شود.

module.exports = mongoose.model('Message', messageSchema);
