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
    phoneHash: { type: String, default: null },
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now },
    role: { type: String, enum: ['user', 'moderator', 'admin'], default: 'user' },
    status: { type: String, enum: ['active', 'suspended', 'banned'], default: 'active' },
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
  },
  { timestamps: true }
);

userSchema.index({ phoneHash: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('User', userSchema);
