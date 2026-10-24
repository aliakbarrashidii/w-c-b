// تصمیم نهایی «برای این کاربر پوش بفرستیم؟» - تنظیم کلی اعلان‌ها + مزاحم نشوید (یک جا، تا همه‌ی مسیرهای ارسال یکسان رفتار کنند)
const { suppressesPush } = require('./dndCore');

function shouldPush(settings, kind = 'message', now = Date.now()) {
  const s = settings || {};
  if (kind === 'message' && s.enabled === false) return false;
  return !suppressesPush(s.dnd, kind, now);
}

module.exports = { shouldPush };
