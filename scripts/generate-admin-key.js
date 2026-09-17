// اجرا: node scripts/generate-admin-key.js
// این اسکریپت فقط یه‌بار اجرا می‌شه (وقتی می‌خوای گزارش‌های رمزشده‌ی فاز ۳ رو راه بندازی).
// کلید خصوصی خروجی رو یه‌جای امن (نه تو گیت، نه رو سرور) نگه دار - فقط با اون می‌شه گزارش‌ها رو باز کرد.
// کلید عمومی رو با PUT /api/admin/settings (فیلد adminReportPublicKey) به سرور بده تا کلاینت‌ها بتونن ببیننش.
const { x25519 } = require('@noble/curves/ed25519.js');

const priv = x25519.utils.randomSecretKey();
const pub = x25519.getPublicKey(priv);

console.log('Admin private key (نگه دار، جایی نده):');
console.log(Buffer.from(priv).toString('base64'));
console.log('\nAdmin public key (این رو با PUT /api/admin/settings ثبت کن):');
console.log(Buffer.from(pub).toString('base64'));
