const mongoose = require('mongoose');

// ربات: یه کاربرِ ویژه (User.isBot) + تنظیمات رفتار. توکن فقط به‌صورت هش ذخیره می‌شه (یک‌بار موقع ساخت نشون داده می‌شه)
const botSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, index: true },
    // commands: بدون کد (دستور => پاسخ/دکمه)؛ webhook: ربات برنامه‌نویسی‌شده با Bot API؛ agent: عامل هوش مصنوعی (LLM)
    type: { type: String, enum: ['commands', 'webhook', 'agent'], default: 'commands' },
    description: { type: String, default: '', maxlength: 300 },
    active: { type: Boolean, default: true },
    disabledByAdmin: { type: Boolean, default: false },
    commands: [{ command: String, description: { type: String, default: '' }, reply: { type: String, default: '' }, buttons: { type: mongoose.Schema.Types.Mixed, default: undefined }, _id: false }],
    defaultReply: { type: String, default: '' },
    webhookUrl: { type: String, default: '' },
    webhookSecret: { type: String, default: '' },
    agent: {
      baseUrl: { type: String, default: '' }, // سازگار با OpenAI (OpenAI, OpenRouter, Ollama, LM Studio, ...)
      apiKeyEnc: { type: String, default: '' }, // رمزشده با کلید سرور؛ هیچ‌وقت به کلاینت برنمی‌گرده
      model: { type: String, default: '' },
      systemPrompt: { type: String, default: '' },
      temperature: { type: Number, default: 0.7 },
      maxHistory: { type: Number, default: 10 },
    },
    nextUpdateId: { type: Number, default: 1 },
    stats: { messages: { type: Number, default: 0 }, lastActiveAt: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Bot', botSchema);
