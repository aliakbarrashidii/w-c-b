const mongoose = require('mongoose');

const activitySchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['reaction', 'mention'], required: true },
    chat: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true },
    message: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', required: true },
    emoji: { type: String, default: '' }, // فقط برای type=reaction
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

activitySchema.index({ recipient: 1, createdAt: -1 });

module.exports = mongoose.model('Activity', activitySchema);
