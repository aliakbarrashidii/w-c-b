const mongoose = require('mongoose');

// گزارش اقدام‌های مدیریتی هر گروه/کانال (تغییر نقش، حذف/بن عضو، تنظیمات...) - ۳۰ روز نگه‌داری می‌شه
const schema = new mongoose.Schema({
  chat: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', index: true, required: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  action: { type: String, required: true },
  target: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  extra: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now, expires: 30 * 24 * 3600 },
});
module.exports = mongoose.model('ChatAdminLog', schema);
