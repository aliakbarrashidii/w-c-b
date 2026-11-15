// اعتبارسنجیِ بلاکِ مهروموم‌شده‌ی گزارش (خالص). v1 = یک گیرنده (مدیر اصلی)؛ v2 = چندگیرنده با ردیفِ ۰ الزامی.
const B64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
const MAX_KEYS = 10;
const MAX_CT = 400 * 1024; // سقفِ اندازه‌ی ciphertext (کاراکتر)
const okB64 = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && B64.test(s);

function validateSealedBox(box) {
  if (!box || typeof box !== 'object') return { error: 'sealedBox ناقص است' };
  if (!box.v || box.v === 1) {
    if (!okB64(box.ephemeralPublicKey, 200) || !okB64(box.nonce, 100) || !okB64(box.ciphertext, MAX_CT)) return { error: 'sealedBox نامعتبر است' };
    return { value: { v: 1, ephemeralPublicKey: box.ephemeralPublicKey, nonce: box.nonce, ciphertext: box.ciphertext, keys: [] } };
  }
  if (box.v !== 2) return { error: 'نسخه‌ی sealedBox پشتیبانی نمی‌شود' };
  // v2 (multiSeal اپ): محتوا یک‌بار با کلیدِ تصادفیِ K رمز شده → nonce/ciphertext «سطحِ بالا»؛ keys فقط K را برای هر ردیف مهروموم می‌کنند
  if (!okB64(box.nonce, 100) || !okB64(box.ciphertext, MAX_CT)) return { error: 'محتوای رمزشده‌ی sealedBox نامعتبر است' };
  const keys = box.keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS) return { error: 'فهرست کلیدها نامعتبر است' };
  const seen = new Set(); const clean = [];
  for (const k of keys) {
    if (!k || typeof k !== 'object' || !Number.isInteger(k.level) || k.level < 0 || k.level > 9) return { error: 'ردیفِ کلید نامعتبر است' };
    if (seen.has(k.level)) return { error: 'ردیفِ تکراری در کلیدها' };
    seen.add(k.level);
    const version = Number.isInteger(k.version) && k.version > 0 && k.version < 1e6 ? k.version : 1;
    if (!okB64(k.ephemeralPublicKey, 200) || !okB64(k.nonce, 100) || !okB64(k.ciphertext, MAX_CT)) return { error: 'کلیدِ مهروموم نامعتبر است' };
    clean.push({ level: k.level, version, ephemeralPublicKey: k.ephemeralPublicKey, nonce: k.nonce, ciphertext: k.ciphertext });
  }
  if (!seen.has(0)) return { error: 'ردیفِ ۰ (مدیر اصلی) الزامی است' };
  return { value: { v: 2, ephemeralPublicKey: '', nonce: box.nonce, ciphertext: box.ciphertext, keys: clean } };
}

// آنچه یک ناظر با ردیفِ level می‌تواند ببیند: v1 فقط مدیر اصلی؛ v2 فقط ورودیِ ردیفِ خودش. null = چیزی برای باز کردن ندارد.
function sealedFor(box, level) {
  if (!box) return null;
  const plain = typeof box.toObject === 'function' ? box.toObject() : box;
  if (!plain.v || plain.v === 1) {
    if (!plain.ciphertext) return null;
    return level === 0 ? { v: 1, ephemeralPublicKey: plain.ephemeralPublicKey, nonce: plain.nonce, ciphertext: plain.ciphertext } : null;
  }
  const mine = (plain.keys || []).find((k) => k.level === level);
  return mine ? { v: 2, nonce: plain.nonce, ciphertext: plain.ciphertext, keys: [mine] } : null;
}

module.exports = { validateSealedBox, sealedFor, MAX_KEYS };
