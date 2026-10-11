const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema(
  {
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    targetType: { type: String, enum: ['user', 'message', 'chat'], required: true },
    targetUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    targetMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
    category: {
      type: String,
      enum: ['spam', 'harassment', 'sexual_content', 'violence', 'fraud', 'other'],
      required: true,
    },
    description: { type: String, default: '', maxlength: 1000 },
    resolved: { type: Boolean, default: false },
    status: { type: String, enum: ['pending', 'under_review', 'confirmed', 'dismissed'], default: 'pending' },
    decision: { type: mongoose.Schema.Types.Mixed, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    chat: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', default: null },
    sealedContext: { type: mongoose.Schema.Types.Mixed, default: null }, // بافتِ رمزشده‌ی چت‌های E2E که خودِ گزارش‌دهنده می‌فرسته
  },
  { timestamps: true }
);

module.exports = mongoose.model('Report', reportSchema);
