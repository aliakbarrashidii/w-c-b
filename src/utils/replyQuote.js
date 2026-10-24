// «نقل‌قولِ بخشی از پیام» (Reply with quote): فقط «بازه‌ی نویسه‌ها» در متن پیامِ اصلی ذخیره می‌شود، نه خودِ متن.
// دلیل: در چت‌های E2E سرور نباید قطعه‌ای از متن را ببیند؛ گیرنده پیام اصلی را (رمزگشایی‌شده) دارد و خودش برش می‌زند.
const MAX_END = 4000; // سقف طول پیام
function sanitizeReplyQuote(v) {
  if (!v || typeof v !== 'object') return null;
  const { start, end } = v;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end <= start || end > MAX_END) return null;
  return { start, end };
}
module.exports = { sanitizeReplyQuote, MAX_END };
