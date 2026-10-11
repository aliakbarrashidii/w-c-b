const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    chat: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true, index: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    clientId: { type: String, default: null }, // شناسه‌ی سمت کلاینت برای جلوگیری از پیام تکراری (Optimistic UI)
    type: { type: String, enum: ['text', 'image', 'video', 'video_note', 'file', 'voice', 'call_log', 'sticker', 'system_action', 'poll', 'location', 'contact'], default: 'text' },
    content: { type: String, default: '' },
    mediaUrl: { type: String, default: '' },
    mediaMeta: {
      width: Number,
      height: Number,
      durationSec: Number,
      fileName: String,
      fileSizeBytes: Number,
      // بدون این دو فیلد، Mongoose (حالت strict) اون‌ها رو دور می‌ریخت و گیرنده هیچ‌وقت نمی‌فهمید
      // فایل رمزشده‌ست -> بلاب رمزشده رو خام نشون می‌داد (عکس/ویس/ویدیو باز نمی‌شد)
      encrypted: Boolean,
      mimeType: String,
      // پیام‌های system_action (حساب رسمی WizChat): نوع اکشن و پارامترهاش. بدون این‌ها strict mode حذفشون می‌کرد
      // و دکمه‌های «این ورود خودتون بودید؟» / «بروزرسانی» هیچ‌وقت به کلاینت نمی‌رسید
      action: String,
      sessionId: String,
      url: String,
    },
    topic: { type: mongoose.Schema.Types.ObjectId, default: undefined }, // شناسه‌ی تاپیکِ گروه (Chat.topics._id)؛ خالی = «عمومی»
    tags: { type: [String], default: undefined }, // فقط تو چتِ ذخیره‌شده‌ی خودِ کاربر (routes/chats.js → /messages/:id/tags)
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
    expiresAt: { type: Date, default: null }, // برای خودتخریب چت‌های مخفی یا پیام‌های تایم‌دار
    // پیامِ خودمخربِ تایم‌دار (هر نوع چتی، نه فقط چت مخفی): فرستنده مدت رو تعیین می‌کنه، ولی
    // شمارش‌معکوس فقط از لحظه‌ای که گیرنده روش لمس/باز می‌کنه (رویداد message:reveal) شروع می‌شه -
    // نه از لحظه‌ی ارسال. از همون expiresAt بالا و همون جاروب حذفِ ۲۰ثانیه‌ایِ موجود استفاده می‌کنه.
    viewOnceDurationSec: { type: Number, default: null },
    // وقتی پیام به همه‌ی اعضای مقصد (به‌جز فرستنده) تحویل داده شد، این ست می‌شه.
    // تا وقتی null باشه یعنی «نرسیده» و از سقف نگهداری معمولی مستثناست (فقط سقف جداگانه‌ی
    // «نرسیده‌ی خیلی قدیمی» روش اعمال می‌شه) — طبق تنظیمات پنل ادمین (models/Settings.js)
    fullyDeliveredAt: { type: Date, default: null, index: true },
    // پیام‌های چت خصوصی/مخفی که با موتور X3DH+Double Ratchet (mobile-app/src/crypto) رمز شدن:
    // سرور اصلاً نمی‌تونه بازش کنه - content این پیام‌ها همیشه خالیه، محتوای واقعی همینجاست
    // (یه سایفرتکست جدا به‌ازای هر دستگاهِ گیرنده، چون هر دستگاه سشن رمزنگاری خودش رو داره)
    // رأی‌های نظرسنجی: فقط «کدام گزینه»، نه متن سؤال/گزینه‌ها (اون‌ها داخل پیام رمزشده‌ان)
    // بازدید پست‌های کانال (یکتا به‌ازای هر کاربر)؛ فهرست بازدیدکننده‌ها هیچ‌وقت تو جواب API نمیاد
    views: { type: Number, default: 0 },
    viewedBy: { type: [mongoose.Schema.Types.ObjectId], select: false, default: undefined },
    viaBot: { type: Boolean, default: false }, // پیامِ ساخته‌شده توسط ربات (بدون E2E؛ سرور محتواش رو داره)
    botMarkup: { type: mongoose.Schema.Types.Mixed, default: undefined }, // دکمه‌های شیشه‌ای: { buttons: [[{text, callback_data|url}]] }
    pollVotes: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, options: [Number], _id: false }],
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
    // پیام‌های گروهیِ رمزشده با Sender Key (WhatsApp-style) - یه سایفرتکستِ واحد برای کل گروه،
    // نه به‌ازای هر عضو (چون کلید مشترکه، نه pairwise) - سرور نمی‌تونه بازش کنه.
    groupE2e: {
      senderDeviceId: { type: String, default: null },
      iteration: { type: Number, default: null },
      nonce: { type: String, default: null },
      ciphertext: { type: String, default: null },
      signature: { type: String, default: null },
    },
  },
  { timestamps: true }
);

messageSchema.index({ chat: 1, createdAt: -1 });
messageSchema.index({ chat: 1, sender: 1, clientId: 1 });
messageSchema.index({ chat: 1, tags: 1 }, { sparse: true });
messageSchema.index({ chat: 1, topic: 1, createdAt: -1 }, { sparse: true }); // جستجو/شمارش برچسب‌ها تو «پیام‌های ذخیره‌شده»
// توجه: content روی دیتابیس رمزنگاری‌شده ذخیره می‌شود (utils/crypto.js)،
// بنابراین دیگر ایندکس متنی روی آن معنا ندارد؛ جستجو در سطح اپلیکیشن پس از رمزگشایی انجام می‌شود.

// حذف خودکار هر چت: پیامِ جدید (از هر مسیری: ارسال، فوروارد، زمان‌بندی‌شده، ربات، سیستم) اگه چت تایمر داشته باشه
// همون لحظه expiresAt می‌گیره و جاروی ۲۰ثانیه‌ایِ socket/index.js حذفش می‌کنه. پیام ویو‌وانس بعداً مقدار خودش رو می‌ذاره.
messageSchema.pre('save', async function autoDeleteStamp() {
  if (!this.isNew || this.expiresAt) return;
  const chat = await mongoose.model('Chat').findById(this.chat).select('autoDeleteSec type').lean();
  if (chat?.autoDeleteSec > 0 && chat.type !== 'secret' && chat.type !== 'saved') {
    this.expiresAt = new Date(Date.now() + chat.autoDeleteSec * 1000);
  }
});

module.exports = mongoose.model('Message', messageSchema);
