const { getSettings } = require('./settings');

// دسته‌هایی که مدل روی گوشی تشخیص می‌ده (labels مدل) - ادمین برای هر «بخش» جدا انتخاب می‌کنه
// کدوم‌ها گزارش بشن و با چه حداقل اطمینانی. دو بخش: چت‌های خصوصی، و گروه/کانال.
const AI_CATEGORIES = {
  sexual_harassment: 'آزار جنسی / باج‌گیری / تهدید به پخش عکس',
  violence_threat: 'تهدید به خشونت',
  insult_hate: 'توهین و نفرت‌پراکنی',
  sexual_content: 'محتوای جنسی (رضایتی بین دو نفر پیش‌فرض گزارش نمی‌شه)',
};

const DEFAULT_POLICY = {
  scopes: {
    private: {
      sexual_harassment: { enabled: true, minConfidence: 0.7 },
      violence_threat: { enabled: true, minConfidence: 0.7 },
      insult_hate: { enabled: false, minConfidence: 0.85 },
      sexual_content: { enabled: false, minConfidence: 0.9 },
    },
    group: {
      sexual_harassment: { enabled: true, minConfidence: 0.7 },
      violence_threat: { enabled: true, minConfidence: 0.7 },
      insult_hate: { enabled: true, minConfidence: 0.75 },
      sexual_content: { enabled: true, minConfidence: 0.8 },
    },
  },
  // پلکان: وقتی تعداد گزارش‌های تأییدشده علیه یه کاربر به confirmed رسید، این محدودیت خودکار اعمال می‌شه
  escalation: [
    { confirmed: 1, features: ['send_media'], days: 1 },
    { confirmed: 3, features: ['new_chats', 'voice', 'create_groups'], days: 7 },
    { confirmed: 5, features: ['send_messages', 'calls', 'join_groups'], days: 30 },
  ],
  // گزارش‌دهنده‌ی الکی: وقتی ردشده‌ها از حد گذشت و نسبتشون به کل گزارش‌هاش بالا بود
  falseReporter: { rejectedThreshold: 5, minRejectRatio: 0.7, features: ['file_reports'], days: 14 },
};

async function getPolicy(allCategories) {
  const s = await getSettings();
  const custom = s.moderationPolicy || {};
  const fill = (scope) => {
    const out = { ...DEFAULT_POLICY.scopes[scope], ...(custom.scopes?.[scope] || {}) };
    // کلاسِ جدیدِ مدل که ادمین هنوز براش تنظیمی نذاشته: پیش‌فرض خاموش تا ناخواسته گزارش‌ریزی نشه
    for (const k of Object.keys(allCategories || {})) if (!out[k]) out[k] = { enabled: false, minConfidence: 0.8 };
    return out;
  };
  return {
    scopes: { private: fill('private'), group: fill('group') },
    escalation: Array.isArray(custom.escalation) ? custom.escalation : DEFAULT_POLICY.escalation,
    falseReporter: { ...DEFAULT_POLICY.falseReporter, ...(custom.falseReporter || {}) },
  };
}

module.exports = { AI_CATEGORIES, DEFAULT_POLICY, getPolicy };
