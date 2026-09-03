const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    deviceName: { type: String, default: 'دستگاه ناشناس' },
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
    lastActiveAt: { type: Date, default: Date.now },
    revoked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Session', sessionSchema);
