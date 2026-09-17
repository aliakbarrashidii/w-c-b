const mongoose = require('mongoose');

const adminLogSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: {
      type: String,
      enum: [
        'view_chat',
        'view_message',
        'delete_message',
        'ban_user',
        'suspend_user',
        'unban_user',
        'create_user',
        'view_user_profile',
        'update_settings',
      ],
      required: true,
    },
    targetUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    targetChat: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', default: null },
    targetMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
    note: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AdminLog', adminLogSchema);
