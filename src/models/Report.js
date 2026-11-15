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
    // مسیریابیِ پرونده بین ردیف‌های ادمین
    tier: { type: Number, default: 0 },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    assignedAt: { type: Date, default: null },
    dueAt: { type: Date, default: null },
    escalations: [{ from: Number, to: Number, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, at: { type: Date, default: Date.now }, reason: { type: String, default: '' }, auto: { type: Boolean, default: false } }],
    sealedContext: { type: mongoose.Schema.Types.Mixed, default: null }, // بافتِ رمزشده‌ی چت‌های E2E که خودِ گزارش‌دهنده می‌فرسته
  },
  { timestamps: true }
);

module.exports = mongoose.model('Report', reportSchema);
