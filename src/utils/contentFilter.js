// این فقط یه فیلتر ساده‌ی کلیدواژه‌ایه، نه یه مدل هوش مصنوعی واقعی.
// تشخیص واقعی و دقیق آزار/محتوای جنسی/خشونت نیاز به یه مدل آموزش‌دیده (مثل Embedding+BiLSTM)
// با دیتاست برچسب‌خورده‌ی فارسی داره که ساختنش خارج از توان یه پاسخ متنیه — جزئیاتش رو جدا توضیح دادم.
// این فایل فقط یه لایه‌ی حداقلی و قابل‌گسترش برای شروعه؛ کلمات رو خودت/ادمین باید کامل کنه.
const FLAG_PATTERNS = [
  { category: 'spam', pattern: /(http|https):\/\/\S+.*(http|https):\/\/\S+/i }, // چند لینک پشت‌سرهم = احتمال اسپم
  // نمونه‌ی جای خالی برای دسته‌های دیگه — لیست کلمات حساس رو خودِ تیم مدیریت باید بر اساس نیاز واقعی پر کنه:
  // { category: 'harassment', pattern: /.../i },
];

function scanContent(text) {
  if (!text) return null;
  for (const { category, pattern } of FLAG_PATTERNS) {
    if (pattern.test(text)) return category;
  }
  return null;
}

module.exports = { scanContent };
