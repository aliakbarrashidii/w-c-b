const mongoose = require('mongoose');

// یه سند singleton (همیشه key='global') برای تنظیمات کلی سرور که از پنل ادمین قابل تغییره.
const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },
    // پیام‌هایی که به‌طور کامل تحویل داده شدن، این‌قدر بعد از تحویل روی سرور می‌مونن و بعد حذف می‌شن
    messageRetentionSec: { type: Number, default: 172800 }, // پیش‌فرض: ۲ روز
    // پیام‌هایی که هنوز به همه‌ی گیرنده‌ها نرسیدن، حداکثر این‌قدر روی سرور منتظر می‌مونن؛
    // بعدش حتی اگه نرسیده باشن هم حذف می‌شن
    undeliveredMaxWaitSec: { type: Number, default: 604800 }, // پیش‌فرض: ۷ روز
    // مدل تشخیص محتوا (فاز بعدی) نسخه‌ش رو اینجا نگه می‌داره تا ادمین بتونه بروزرسانی کنه
    contentModelVersion: { type: String, default: '' },
    // کلید عمومی ادمین برای گزارش‌های رمزشده (sealed box) - کلید خصوصیش هیچ‌وقت رو سرور نیست
    adminReportPublicKey: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Settings', settingsSchema);
