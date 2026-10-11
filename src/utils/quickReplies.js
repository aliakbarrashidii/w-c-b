// پاسخ‌های سریع کاربر: [{ shortcut, text }]. سرور ورودی رو پاک‌سازی می‌کنه (سقف تعداد/طول، حذف تکراری، کاراکتر مجاز)؛ کلاینت‌ها هم‌گام می‌شن.
const MAX_QUICK_REPLIES = 20;

function sanitizeQuickReplies(input) {
  if (!Array.isArray(input)) return null;
  const seen = new Set();
  const out = [];
  for (const item of input.slice(0, MAX_QUICK_REPLIES)) {
    if (!item || typeof item !== 'object' || typeof item.shortcut !== 'string' || typeof item.text !== 'string') continue; // شیء/عدد داخل فیلدها = رد (قبلاً String(obj) → «[object Object]»)
    // میان‌بر: بدون «/» اول، فقط حرف/عدد/زیرخط (هر زبان)، حداکثر ۲۰ کاراکتر
    const shortcut = String(item.shortcut ?? '').trim().replace(/^\/+/, '').toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 20);
    const text = String(item.text ?? '').replace(/\r\n/g, '\n').trim().slice(0, 500);
    if (!shortcut || !text || seen.has(shortcut)) continue;
    seen.add(shortcut);
    out.push({ shortcut, text });
  }
  return out;
}

module.exports = { sanitizeQuickReplies, MAX_QUICK_REPLIES };
