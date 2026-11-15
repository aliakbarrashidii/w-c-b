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
  // پلکانِ محدودیت (خودکار، بعد از «تأییدِ» ادمین). پله‌ی بدونِ category = شمارشِ همه‌ی دسته‌ها؛ با category = فقط همان دسته.
  // طراحی: ۱) دسته‌های جدی (تهدید/آزار) از اولین تأیید و سریع‌تر بالا می‌روند، دسته‌های کوچک (توهین/جنسیِ رضایتی) دیرتر و سبک‌تر.
  // ۲) محدودیت‌ها اول «تماس با غریبه‌ها» را می‌بندند (چت جدید، تماس، ساخت/عضویت گروه) و ارسالِ پیام به دوستانِ قبلی آخر بسته می‌شود.
  // ۳) هیچ پلهٔ خودکاری دائمی نیست؛ دائمی/طولانی‌تر فقط تصمیمِ دستیِ ادمین است (decide با features/days دستی، تا سقفِ ردیفِ او).
  escalation: [
    { confirmed: 1, features: ['send_media'], days: 1 },
    { confirmed: 3, features: ['new_chats', 'voice', 'create_groups'], days: 7 },
    { confirmed: 5, features: ['send_messages', 'calls', 'join_groups'], days: 30 },
    { confirmed: 8, features: ['send_messages', 'send_media', 'voice', 'stickers', 'new_chats', 'calls', 'create_groups', 'join_groups'], days: 90 },
    // تهدید به خشونت (جدی)
    { confirmed: 1, category: 'violence_threat', features: ['new_chats', 'calls', 'create_groups'], days: 7 },
    { confirmed: 2, category: 'violence_threat', features: ['new_chats', 'calls', 'create_groups', 'join_groups', 'send_media', 'voice'], days: 30 },
    { confirmed: 3, category: 'violence_threat', features: ['send_messages', 'send_media', 'voice', 'stickers', 'new_chats', 'calls', 'create_groups', 'join_groups'], days: 90 },
    // آزار/باج‌گیری جنسی (جدی)
    { confirmed: 1, category: 'sexual_harassment', features: ['new_chats', 'send_media', 'voice'], days: 7 },
    { confirmed: 2, category: 'sexual_harassment', features: ['new_chats', 'send_media', 'voice', 'calls', 'create_groups', 'join_groups'], days: 30 },
    { confirmed: 3, category: 'sexual_harassment', features: ['send_messages', 'send_media', 'voice', 'stickers', 'new_chats', 'calls', 'create_groups', 'join_groups'], days: 90 },
    // توهین/نفرت (کوچک)
    { confirmed: 3, category: 'insult_hate', features: ['send_media'], days: 1 },
    { confirmed: 5, category: 'insult_hate', features: ['new_chats', 'voice', 'calls'], days: 7 },
    { confirmed: 8, category: 'insult_hate', features: ['send_messages'], days: 7 },
    // محتوای جنسی (کوچک)
    { confirmed: 3, category: 'sexual_content', features: ['send_media', 'voice'], days: 3 },
    { confirmed: 6, category: 'sexual_content', features: ['new_chats', 'send_media', 'voice'], days: 14 },
  ],
  // دسته‌های «جدی»: فقط این‌ها حتی در گفتگوی دوطرفه/تلافی‌جویانه هم برای بررسی می‌آیند؛ بقیه فقط وقتی گزارش می‌شوند که
  // یک‌طرفه و تکراری باشند (جزئیات: mobile-app/src/moderation/contextDecision.js)
  serious: ['violence_threat', 'sexual_harassment'],
  // گزارشِ هوش مصنوعیِ تکراریِ همان چت/متهم/دسته در این بازه (دقیقه) به یک پرونده تبدیل می‌شود (گروه: «یک گزارش»، نه یکی از هر عضو)
  dedupeMinutes: 60,
  // یادگیری از تصمیم‌های ادمین: نمونه‌ی برچسب‌دار (فقط یک پیامِ بررسی‌شده، بدونِ شناسه) + کالیبراسیونِ خودکارِ آستانه‌ها (روزی یک‌بار)
  training: { enabled: true, retentionDays: 365, autoCalibrate: true, targetPrecision: 0.8, minSamples: 30 },
  // گزارش‌دهنده‌ی الکی: وقتی ردشده‌ها از حد گذشت و نسبتشون به کل گزارش‌هاش بالا بود
  falseReporter: { rejectedThreshold: 5, minRejectRatio: 0.7, features: ['file_reports'], days: 14 },
  // زیرنظرِ خودکار: N گزارش در M روز ⇒ فقط پرچمِ «زیر بررسی» (هیچ محدودیتی اعمال نمی‌شود)
  watch: { reports: 5, days: 30 },
};

// ساختار: {private|group: {دسته: {enabled: bool, minConfidence: 0.5..0.99}}} — هر چیزِ دیگر دور ریخته می‌شود.
// (قبلاً فقط مقدارهای boolean نگه داشته می‌شد در حالی که صفحه‌ی ادمین شیء می‌فرستد ⇒ هیچ تنظیمی ذخیره نمی‌شد.)
function sanitizeScopes(input) {
  const out = {};
  for (const scope of ['private', 'group']) {
    const src = input?.[scope];
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    out[scope] = {};
    for (const [cat, v] of Object.entries(src)) {
      if (!/^[a-z0-9_]{1,40}$/i.test(cat) || !v || typeof v !== 'object') continue;
      const mc = Number(v.minConfidence);
      out[scope][cat] = { enabled: v.enabled === true, minConfidence: Number.isFinite(mc) ? Math.min(0.99, Math.max(0.5, mc)) : 0.8 };
    }
  }
  return out;
}

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
    watch: { ...DEFAULT_POLICY.watch, ...(custom.watch || {}) },
    serious: Array.isArray(custom.serious) ? custom.serious : DEFAULT_POLICY.serious,
    dedupeMinutes: Number.isFinite(custom.dedupeMinutes) ? custom.dedupeMinutes : DEFAULT_POLICY.dedupeMinutes,
    training: { ...DEFAULT_POLICY.training, ...(custom.training || {}) },
  };
}

module.exports = { AI_CATEGORIES, DEFAULT_POLICY, getPolicy, sanitizeScopes };
