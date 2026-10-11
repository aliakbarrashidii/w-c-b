// تاپیک‌های گروه (نسخه‌ی اول: دسته‌بندی پیام‌ها تو یک گروه). عنوان ≤۳۰ و ایموجی ≤۸ کاراکتر؛ حداکثر ۲۰ تاپیک.
const MAX_TOPICS = 20;

function sanitizeTopic(input) {
  if (!input || typeof input !== 'object') return null;
  const title = typeof input.title === 'string' ? input.title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30) : '';
  const emoji = typeof input.emoji === 'string' ? input.emoji.replace(/[\u0000-\u001f\u007f\s]/g, '').slice(0, 8) : '';
  if (!title) return null;
  return { title, emoji };
}

module.exports = { sanitizeTopic, MAX_TOPICS };
