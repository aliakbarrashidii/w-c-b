const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    displayName: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    avatarUrl: { type: String, default: '' },
    avatarUrls: [{ type: String }], // تاریخچه‌ی عکس‌های پروفایل — می‌تونه چندتا داشته باشه، avatarUrl همیشه فعلی‌شه
    bio: { type: String, default: '', maxlength: 200 },
    phone: { type: String, default: '' },
    // بدون default: مقدار null هم توی ایندکس یکتا ثبت می‌شد و فقط «یک» کاربرِ بدون تلفن (ربات/ساخته‌شده توسط مدیر/سیستم) اجازه‌ی وجود داشت
    phoneHash: { type: String },
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now },
    role: { type: String, enum: ['user', 'moderator', 'admin'], default: 'user' },
    // اکانتِ رسمیِ خودِ اپ (اعلان‌ها، هشدار ورودِ جدید و...) - تو مخاطبین ذخیره نمی‌شه، خودکار ساخته می‌شه
    isSystem: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'suspended', 'banned', 'deleted'], default: 'active' },
    suspendedUntil: { type: Date, default: null },
    banReason: { type: String, default: '' },
    theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
    defaultWallpaper: { type: String, default: null }, // پس‌زمینه‌ی پیش‌فرض همه‌ی چت‌ها (رنگ هگز یا URL عکس)
    coverId: { type: String, default: 'blue' }, // کاور پروفایل - یکی از پیش‌فرض‌های همراه اپ (blue/sunset/teal/dark/warm)
    blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    contactNotes: [
      {
        contact: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        note: { type: String, default: '', maxlength: 500 },
      },
    ],
    pushTokens: [{ type: String }],
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: { type: String, default: '' },
    privacy: {
      lastSeenVisibility: { type: String, enum: ['everyone', 'nobody'], default: 'everyone' },
      lastSeenExceptions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // اگه everyone: این‌ها استثنا و ازشون مخفیه؛ اگه nobody: فقط این‌ها می‌بینن
      readReceiptsEnabled: { type: Boolean, default: true },
    },
    notificationSettings: {
      enabled: { type: Boolean, default: true },
      sound: { type: Boolean, default: true },
      preview: { type: Boolean, default: true },
    },
    folders: [
      {
        name: { type: String, required: true, maxlength: 30 },
        chatIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Chat' }],
      },
    ],
    createdByAdmin: { type: Boolean, default: false },
    // مخاطبین ذخیره‌شده با اسم دلخواهِ خودِ کاربر (سروری تا با هر دستگاهی بمونه)
    savedContacts: [{ contact: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, name: { type: String, default: '', maxlength: 60 } }],
    // کسانی که شماره‌ی من رو می‌بینن: وقتی کسی رو به مخاطبینم اضافه می‌کنم، شماره‌ام براش نمایش داده می‌شه
    sharedPhoneWith: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // اطلاعات کلاینت (برای هدف‌گیری اطلاعیه‌های همگانی) - خودِ اپ موقع باز شدن گزارش می‌ده
    client: {
      language: { type: String, default: '' },
      appVersion: { type: String, default: '' },
      platform: { type: String, default: '' },
      reportedAt: { type: Date, default: null },
    },
    // تنظیمات ظاهری/رفتاری اپ که بین دستگاه‌های یه حساب همگام می‌شه (فقط کلیدهای مجاز - routes/auth.js)
    appSettings: {
      themeId: { type: String, default: '' },
      linkPreviews: { type: Boolean, default: null },
      quickReplies: [{ shortcut: String, text: String, _id: false }], // پاسخ‌های سریع (utils/quickReplies.js)
    },
    tokenVersion: { type: Number, default: 0 }, // با هر «ابطال توکن‌ها» بالا می‌ره (utils/tokens.js)
    isBot: { type: Boolean, default: false },
    botOwner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // ورود با تلگرام (مرحله ۱۵)
    telegramId: { type: String }, // بدون default (همون دلیل phoneHash)
    telegramUsername: { type: String, default: '' },
    // پک‌های استیکری که کاربر به حسابش اضافه کرده (سروری می‌مونه تا با دستگاه جدید هم باشه)
    stickerPacks: [{ type: mongoose.Schema.Types.ObjectId, ref: 'StickerPack' }],
    // محدودیت‌های فعال - هر کدوم یه مجموعه‌ی قابلیت + تاریخ پایان + دلیل؛ ادمین تک‌تک قابل‌تنظیم
    restrictions: [
      {
        features: [{ type: String }], // utils/restrictions.js -> FEATURES
        until: { type: Date, default: null }, // null = نامحدود تا ادمین برداره
        reason: { type: String, default: '' },
        createdAt: { type: Date, default: Date.now },
        source: { type: String, default: 'admin' }, // admin | auto
      },
    ],
    // پرونده‌ی نظارتی: چند بار گزارش شده/تأیید شده، و چند بار خودش گزارش داده/رد شده
    moderation: {
      reportsAgainst: { type: Number, default: 0 },
      reportsAgainstConfirmed: { type: Number, default: 0 },
      reportsFiled: { type: Number, default: 0 },
      reportsFiledConfirmed: { type: Number, default: 0 },
      reportsFiledRejected: { type: Number, default: 0 },
      underReview: { type: Boolean, default: false }, // «زیر بررسی» - محدودیتی نداره ولی ادمین می‌پاییدش
      reviewNote: { type: String, default: '' },
    },
  },
  { timestamps: true }
);

userSchema.index({ phoneHash: 1 }, { unique: true, partialFilterExpression: { phoneHash: { $type: 'string' } } });
userSchema.index({ telegramId: 1 }, { unique: true, partialFilterExpression: { telegramId: { $type: 'string' } } });

module.exports = mongoose.model('User', userSchema);
