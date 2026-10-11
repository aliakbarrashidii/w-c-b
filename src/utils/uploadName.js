const path = require('path');
const crypto = require('crypto');

// نام امن برای فایل آپلودی: ۱۲۸ بیت تصادفیِ رمزنگاری‌شده + پسوندِ پاک‌سازی‌شده (قابل‌حدس‌نبودن مهم‌ه چون /uploads بدون احراز هویت سرو می‌شه).
// پسوندهای قابل‌اجرا تو مرورگر (html/svg/js/…) به .bin تبدیل می‌شن تا از دامنه‌ی API اجرا نشن (stored XSS).
const DANGEROUS_EXT = new Set(['.html', '.htm', '.xhtml', '.svg', '.svgz', '.xml', '.xsl', '.js', '.mjs', '.cjs', '.jsx', '.php', '.phtml', '.jsp', '.asp', '.aspx', '.swf', '.hta', '.shtml']);

function safeUploadName(originalname) {
  let ext = path.extname(originalname || '').toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(ext) || DANGEROUS_EXT.has(ext)) ext = ext ? '.bin' : '';
  return `${crypto.randomBytes(16).toString('hex')}${ext}`;
}

module.exports = { safeUploadName, DANGEROUS_EXT };
