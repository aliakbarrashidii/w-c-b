const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    displayName: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    avatarUrl: { type: String, default: '' },
    bio: { type: String, default: '', maxlength: 200 },
    phone: { type: String, default: '' },
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now },
    role: { type: String, enum: ['user', 'moderator', 'admin'], default: 'user' },
    status: { type: String, enum: ['active', 'suspended', 'banned'], default: 'active' },
    suspendedUntil: { type: Date, default: null },
    banReason: { type: String, default: '' },
    theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
    blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    pushTokens: [{ type: String }],
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: { type: String, default: '' },
    createdByAdmin: { type: Boolean, default: false },
  },
  { timestamps: true }
);

userSchema.index({ username: 'text', displayName: 'text' });

module.exports = mongoose.model('User', userSchema);
