const jwt = require('jsonwebtoken');

// تأیید توکن دسترسی - تنها نقطه‌ی تأییدِ JWT برای API، سوکت و لینک تلگرام.
// ⚠️ مهم: توکن موقتِ «در انتظار 2FA» (twoFactorPending) بعد از مرحله‌ی رمز عبور صادر می‌شه و فقط به /auth/login/2fa اجازه‌ی تبدیل شدن به توکن واقعی
// رو می‌ده. قبلاً میدل‌ویر و سوکت اون رو هم به‌عنوان توکن کامل می‌پذیرفتن = با دونستن «فقط رمز» می‌شد 2FA رو کامل دور زد.
function verifyAccessToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  if (payload.twoFactorPending) throw new Error('two-factor token is not an access token');
  return payload;
}

// ابطال توکن‌های بدون نشست (مثل توکن ادمین): با بالا بردن User.tokenVersion همه‌ی توکن‌های قبلی که `tv` دارن باطل می‌شن.
// توکن بدون `tv` (توکن‌های قدیمی/نشست‌دار) با sid کنترل می‌شن و تحت‌تأثیر نیستن.
function isTokenCurrent(payload, user) {
  return payload.tv === undefined || payload.tv === (user?.tokenVersion || 0);
}

module.exports = { verifyAccessToken, isTokenCurrent };
