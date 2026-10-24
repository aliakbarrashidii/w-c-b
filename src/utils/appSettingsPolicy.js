// اعتبارسنجی تنظیمات همگام‌شده‌ی اپ (زبان، ترجیحات قفل برنامه، ترجیحات ترجمه) - خالص و قابل تست.
// عمداً همگام نمی‌شود: کد/PIN قفل برنامه، روشن/خاموش‌بودن قفل (مخصوص هر گوشی است) و کلید API ترجمه (راز کاربر).
// هر گروه یک مهر زمانی (at) دارد؛ آخرین نوشتن برنده است، و نوشتنِ قدیمی‌تر از مقدار ثبت‌شده نادیده گرفته می‌شود.
const LANG_CODES = ['en', 'zh', 'es', 'hi', 'ar', 'pt', 'ru', 'fr', 'de', 'ja', 'ko', 'id', 'tr', 'it', 'pl', 'vi', 'th', 'nl', 'uk', 'fa'];
const LOCK_MODES = ['immediate', 'on_exit', 'timer'];
const MAX_SKEW_MS = 5 * 60 * 1000; // ساعت گوشی تا ۵ دقیقه جلوتر از سرور قابل‌قبول است

function sanitizeLanguage(v) {
  return typeof v === 'string' && LANG_CODES.includes(v) ? v : null;
}

function sanitizeLockPrefs(v) {
  if (!v || typeof v !== 'object') return null;
  const out = {};
  if (v.autoLockMode !== undefined) { if (!LOCK_MODES.includes(v.autoLockMode)) return null; out.autoLockMode = v.autoLockMode; }
  if (v.autoLockMinutes !== undefined) {
    const n = Number(v.autoLockMinutes);
    if (!Number.isInteger(n) || n < 1 || n > 1440) return null;
    out.autoLockMinutes = n;
  }
  if (v.hideNotificationContent !== undefined) { if (typeof v.hideNotificationContent !== 'boolean') return null; out.hideNotificationContent = v.hideNotificationContent; }
  return Object.keys(out).length ? out : null;
}

// فقط ترجیحات غیرمحرمانه: آدرس سرویس، مدل و زبان مقصد. (apiKey و consentHost هرگز)
function sanitizeTranslatePrefs(v) {
  if (!v || typeof v !== 'object') return null;
  const out = {};
  if (v.baseUrl !== undefined) {
    if (typeof v.baseUrl !== 'string' || v.baseUrl.length > 300) return null;
    const u = v.baseUrl.trim();
    if (u) { try { const p = new URL(u); if (!['https:', 'http:'].includes(p.protocol)) return null; if (p.username || p.password) return null; } catch { return null; } }
    out.baseUrl = u;
  }
  if (v.model !== undefined) { if (typeof v.model !== 'string' || v.model.length > 80) return null; out.model = v.model.trim(); }
  if (v.target !== undefined) { if (v.target !== '' && !LANG_CODES.includes(v.target)) return null; out.target = v.target; }
  return Object.keys(out).length ? out : null;
}

// مهر زمانی پذیرفتنی؟ باید عدد صحیح مثبت، نه در آینده‌ی دور، و تازه‌تر از مقدار ثبت‌شده باشد. خروجی: عدد یا null
function acceptStamp(prevAt, at, now = Date.now()) {
  if (!Number.isFinite(at) || at <= 0) return null;
  if (at > now + MAX_SKEW_MS) return null;
  if (at <= (prevAt || 0)) return null;
  return Math.floor(at);
}

module.exports = { LANG_CODES, LOCK_MODES, MAX_SKEW_MS, sanitizeLanguage, sanitizeLockPrefs, sanitizeTranslatePrefs, acceptStamp };
