const crypto = require('crypto');

// کلید ۳۲ بایتی (۶۴ کاراکتر هگز) — باید در .env تنظیم شود، هرگز در کد هاردکد نشود
const KEY = Buffer.from(process.env.MESSAGE_ENCRYPTION_KEY || '', 'hex');

if (KEY.length !== 32 && process.env.NODE_ENV !== 'test') {
  console.warn(
    '⚠ MESSAGE_ENCRYPTION_KEY تنظیم نشده یا طول آن اشتباه است (باید ۶۴ کاراکتر هگز باشد). ' +
      'با: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" یک کلید بساز.'
  );
}

const ALGO = 'aes-256-gcm';

/**
 * متن ساده را رمزنگاری می‌کند و یک رشته یکپارچه (iv:authTag:ciphertext در base64) برمی‌گرداند.
 * این رمزنگاری فقط برای «داده در حال سکون» (at rest) روی دیتابیس است؛
 * سرور کلید را در اختیار دارد و می‌تواند برای پنل ادمین رمزگشایی کند —
 * شبیه مدل «چت ابری» تلگرام، نه چت مخفی/سرتاسری.
 */
function encryptText(plainText) {
  if (plainText === '' || plainText === null || plainText === undefined) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptText(payload) {
  if (!payload) return '';
  try {
    const [ivB64, tagB64, dataB64] = payload.split(':');
    if (!ivB64 || !tagB64 || !dataB64) return payload; // داده قدیمی/غیررمزنگاری‌شده
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    return '[خطا در رمزگشایی پیام]';
  }
}

module.exports = { encryptText, decryptText };
