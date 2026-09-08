const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['private', 'group', 'saved'], required: true },
    pinnedMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
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
        clearedAt: { type: Date, default: null },
        wallpaper: { type: String, default: null }, // رنگ هگز اختصاصی این چت برای همین کاربر، یا null = پیش‌فرض تم // پیام‌های قبل از این تاریخ برای همین کاربر نمایش داده نمی‌شن ("پاک کردن تاریخچه")
      },
    ],
    lastMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
    lastActivityAt: { type: Date, default: Date.now },
    isArchivedByAdmin: { type: Boolean, default: false },
  },
  { timestamps: true }
);

chatSchema.index({ 'members.user': 1 });
chatSchema.index({ title: 'text' });

module.exports = mongoose.model('Chat', chatSchema);
