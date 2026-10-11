const mongoose = require('mongoose');

// صفِ آپدیت‌های ربات‌هایی که webhook ندارن و از getUpdates می‌خونن (۲ روز نگه‌داری)
const schema = new mongoose.Schema({
  bot: { type: mongoose.Schema.Types.ObjectId, ref: 'Bot', required: true },
  updateId: { type: Number, required: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now, expires: 2 * 24 * 3600 },
});
schema.index({ bot: 1, updateId: 1 });
module.exports = mongoose.model('BotUpdate', schema);
