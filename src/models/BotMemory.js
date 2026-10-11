const mongoose = require('mongoose');

// حافظه‌ی گفتگوی ربات‌های هوش مصنوعی (agent) - قبلاً فقط تو RAM بود: با هر ری‌استارت سرور پاک می‌شد و برای هر چتِ تازه
// بی‌نهایت رشد می‌کرد. اینجا هر (ربات، چت) یک سند دارد؛ متن رمز می‌شود (مثل Message.content)، حداکثر ۴۰ پیام نگه
// می‌داریم و بعد از ۳۰ روز بی‌استفاده خودکار حذف می‌شود (TTL). کاربر هم با /reset می‌تواند پاکش کند.
const schema = new mongoose.Schema({
  bot: { type: mongoose.Schema.Types.ObjectId, ref: 'Bot', required: true },
  chat: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true },
  messages: [{ role: { type: String, enum: ['user', 'assistant'] }, content: String, _id: false }],
  updatedAt: { type: Date, default: Date.now, expires: 30 * 24 * 3600 },
});
schema.index({ bot: 1, chat: 1 }, { unique: true });

module.exports = mongoose.model('BotMemory', schema);
