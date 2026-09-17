const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema(
  {
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    targetType: { type: String, enum: ['user', 'message'], required: true },
    targetUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    targetMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
    category: {
      type: String,
      enum: ['spam', 'harassment', 'sexual_content', 'violence', 'fraud', 'other'],
      required: true,
    },
    description: { type: String, default: '', maxlength: 1000 },
    resolved: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Report', reportSchema);
