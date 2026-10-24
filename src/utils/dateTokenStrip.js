// توکن «تاریخ قالب‌دار» ({t:<ثانیه>:<قالب>}) را برای پیش‌نمایش پوش/لیست با 📅 جایگزین می‌کند؛
// سرور منطقه‌ی زمانی و زبان گیرنده را نمی‌داند، پس خودش فرمت نمی‌کند (هم‌الگو با mobile-app/src/utils/dateToken.js).
const TOKEN = /\{t:\d{1,11}:[dDtfr]\}/g;
function stripDateTokens(s) { return String(s ?? '').replace(TOKEN, '📅'); }
module.exports = { stripDateTokens };
