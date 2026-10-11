// برچسب پیام‌های ذخیره‌شده (چتِ «پیام‌های ذخیره‌شده»): حداکثر ۵ برچسب، هرکدام ≤۲۰ کاراکتر، فقط حرف/عدد/زیرخط (هر زبان)، یکتا، حروف کوچک.
const MAX_TAGS = 5;

function sanitizeTags(input) {
  let list = input;
  if (typeof list === 'string') list = list.split(/[\s,،]+/); // «work ideas» یا «work,ideas»
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue; // شیء/عدد/null به «[object Object]» تبدیل می‌شد و برچسب بی‌معنی می‌ساخت
    const tag = String(raw).trim().replace(/^#+/, '').toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 20);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

module.exports = { sanitizeTags, MAX_TAGS };
