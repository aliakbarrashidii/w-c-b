const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    chat: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true, index: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['text', 'image', 'video', 'file', 'voice', 'call_log'], default: 'text' },
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
    flagged: { type: Boolean, default: false },
    flagReason: { type: String, default: '' },
  },
  { timestamps: true }
);

messageSchema.index({ chat: 1, createdAt: -1 });
// توجه: content روی دیتابیس رمزنگاری‌شده ذخیره می‌شود (utils/crypto.js)،
// بنابراین دیگر ایندکس متنی روی آن معنا ندارد؛ جستجو در سطح اپلیکیشن پس از رمزگشایی انجام می‌شود.

module.exports = mongoose.model('Message', messageSchema);
