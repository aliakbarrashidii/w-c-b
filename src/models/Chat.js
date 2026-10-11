const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['private', 'group', 'channel', 'secret', 'saved'], required: true },
    secretSettings: {
      ttlSeconds: { type: Number, default: 0 }, // ۰ یعنی خودتخریب خاموشه
      passphraseHash: { type: String, default: null }, // فقط برای تایید «همون عبارت رو زدید»، نه خودِ کلید
    },
    pinnedMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null }, // قدیمی (تک‌پین) - برای نسخه‌های قدیمی اپ = آخرین پین
    pinnedMessages: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Message' }], // پین چندتایی (حداکثر ۱۰؛ قدیمی‌ترین اول)
    title: { type: String, default: '' }, // group only
    avatarUrl: { type: String, default: '' }, // group only
    description: { type: String, default: '' }, // group only
    members: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        role: { type: String, enum: ['member', 'admin', 'owner'], default: 'member' },
        joinedAt: { type: Date, default: Date.now },
        mutedUntil: { type: Date, default: null },
        archived: { type: Boolean, default: false },
        pinnedInList: { type: Boolean, default: false },
        tag: { type: String, default: '', maxlength: 16 }, // برچسب عضو (مثلاً «طراح»)؛ توسط ادمین تعیین می‌شه و کنار نام فرستنده نمایش داده می‌شه
        markedUnread: { type: Boolean, default: false }, // «علامت‌گذاری به‌عنوان خوانده‌نشده» دستی (نقطه‌ی آبی روی چت)
        clearedAt: { type: Date, default: null },
        rights: { type: mongoose.Schema.Types.Mixed, default: undefined }, // حقوق این ادمین (utils/chatRights.js)
        restrictedUntil: { type: Date, default: null }, // سکوتِ موقتِ این عضو توسط مدیر
        wallpaper: { type: String, default: null }, // رنگ هگز اختصاصی این چت برای همین کاربر، یا null = پیش‌فرض تم // پیام‌های قبل از این تاریخ برای همین کاربر نمایش داده نمی‌شن ("پاک کردن تاریخچه")
      },
    ],
    lastMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
    lastActivityAt: { type: Date, default: Date.now },
    isArchivedByAdmin: { type: Boolean, default: false },
    // حالت آهسته (گروه): حداقل فاصله‌ی ثانیه‌ای بین دو پیام یک عضو عادی؛ ۰ = خاموش. ادمین/مالک مستثنی‌اند
    slowModeSec: { type: Number, default: 0 },
    // تاپیک‌های گروه (دسته‌بندی پیام‌ها؛ حداکثر ۲۰) - utils/topics.js
    topics: [{ title: { type: String, maxlength: 30 }, emoji: { type: String, default: '', maxlength: 8 }, createdAt: { type: Date, default: Date.now } }],
    allowMemberTags: { type: Boolean, default: false }, // اعضا می‌تونن برچسب «خودشون» رو تعیین کنن (پیش‌فرض: فقط ادمین)
    signMessages: { type: Boolean, default: false }, // کانال: نمایش نام ادمینِ نویسنده روی هر پست (خاموش = پست از طرف خودِ کانال)
    // حذف خودکار پیام‌های چت (ثانیه از لحظه‌ی ارسال): ۰ = خاموش | ۱ روز | ۱ هفته | ۱ ماه. چت مخفی تایمر خودش رو داره (secretSettings.ttlSeconds)
    autoDeleteSec: { type: Number, default: 0 },
    // مجوزهای پیش‌فرض اعضای عادی (false = ممنوع)
    permissions: { type: mongoose.Schema.Types.Mixed, default: {} },
    banned: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // پیوستن با لینک نیاز به تأیید مدیر داره؟
    joinApproval: { type: Boolean, default: false },
    joinRequests: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, at: { type: Date, default: Date.now }, _id: false }],
    // لینک دعوت (فقط گروه/کانال): هر کسی با کد می‌تونه عضو بشه تا ادمین کد رو بازنشانی کنه
    inviteCode: { type: String, default: null, index: { unique: true, sparse: true } },
    // نام کاربری عمومی: گروه/کانالِ قابل‌جستجو و ورود مستقیم (فقط وقتی مالک بخواد)
    publicUsername: { type: String, default: null, lowercase: true, index: { unique: true, sparse: true } },
  },
  { timestamps: true }
);

chatSchema.index({ 'members.user': 1 });
chatSchema.index({ title: 'text' });

module.exports = mongoose.model('Chat', chatSchema);
