const nacl = require('tweetnacl');

// این ماژول جدا از رمزنگاری اصلی E2E پیام‌هاست. وقتی مدل تشخیص محتوای روی گوشی یه پیام رو
// فلگ می‌کنه، اپ فقط همون پیام (+ یکی‌دو پیام قبل/بعدش برای بافت) رو با کلید عمومیِ گزارش
// (Settings.reportPublicKey) به روش X25519 Sealed Box قفل می‌کنه و می‌فرسته. یعنی:
// - سرور/دیتابیس بدون کلید خصوصی گزارش، این محتوا رو هم نمی‌تونه بخونه
// - بقیه‌ی مکالمه (که فلگ نشده) همچنان با کلید سشن خودِ دو طرف رمزه و اصلاً به این کلید ربطی نداره
// - فقط پنل ادمین (که کلید خصوصی گزارش رو داره) می‌تونه محتوای گزارش‌شده رو ببینه
const REPORT_PRIVATE_KEY = process.env.REPORT_PRIVATE_KEY
  ? Buffer.from(process.env.REPORT_PRIVATE_KEY, 'base64')
  : null;

// «Sealed Box»: فرستنده یه جفت‌کلید یک‌بارمصرف (Ephemeral) می‌سازه، با nacl.box می‌بنده،
// و کلید عمومیِ Ephemeral خودش رو کنار متن رمزشده می‌فرسته. گیرنده با کلید خصوصیِ ثابتِ خودش
// + همون Ephemeral Public Key می‌تونه بازش کنه. فرستنده هیچ‌وقت لازم نیست کلید خصوصی خودش رو بفرسته.
function decryptReportPayload({ ephemeralPubKey, nonce, ciphertext }) {
  if (!REPORT_PRIVATE_KEY || REPORT_PRIVATE_KEY.length !== 32) {
    throw new Error('REPORT_PRIVATE_KEY تنظیم نشده یا نامعتبره - نمی‌شه گزارش رو رمزگشایی کرد');
  }
  const opened = nacl.box.open(
    Buffer.from(ciphertext, 'base64'),
    Buffer.from(nonce, 'base64'),
    Buffer.from(ephemeralPubKey, 'base64'),
    new Uint8Array(REPORT_PRIVATE_KEY)
  );
  if (!opened) return null;
  return JSON.parse(Buffer.from(opened).toString('utf8'));
}

module.exports = { decryptReportPayload };
