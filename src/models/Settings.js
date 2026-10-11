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
    // نگهداریِ جداگانه برای هر نوع رسانه - اگه برای یه نوع مقدار گذاشته نشه (null)، همون
    // messageRetentionSec بالا براش اعمال می‌شه. کلیدها دقیقاً با Message.type یکی‌ان.
    mediaRetentionSec: {
      image: { type: Number, default: null },
      video: { type: Number, default: null },
      voice: { type: Number, default: null },
      video_note: { type: Number, default: null },
      file: { type: Number, default: null },
    },
    // مدل تشخیص محتوا (فاز بعدی) نسخه‌ش رو اینجا نگه می‌داره تا ادمین بتونه بروزرسانی کنه
    contentModelVersion: { type: String, default: '' },
    // کلید عمومی ادمین برای گزارش‌های رمزشده (sealed box) - کلید خصوصیش هیچ‌وقت رو سرور نیست
    adminReportPublicKey: { type: String, default: '' },
    // حداکثر حجم آپلود (مگابایت) - چه برای عکس/ویس/ویدیو چه فایل معمولی
    maxUploadSizeMb: { type: Number, default: 50 },
    // سیاست نظارت (از پنل ادمین): دسته‌های قابل‌گزارش به تفکیک دو بخش (چت خصوصی / گروه و کانال)،
    // پلکان محدودیت بر اساس تعداد گزارش تأییدشده، و جریمه‌ی گزارش‌دهنده‌ی الکی
    moderationPolicy: { type: mongoose.Schema.Types.Mixed, default: {} },
    // سیاست ربات‌ها: آیا کاربران می‌تونن ربات بسازن، حداکثر تعداد، محدودیت عامل‌های هوش مصنوعی (هزینه‌ی LLM)
    botPolicy: { type: mongoose.Schema.Types.Mixed, default: {} },
    telegramLoginEnabled: { type: Boolean, default: true },
    // دسترسی ناظرها به پیام چت‌ها: 'all' = همه‌ی چت‌های غیر E2E (پیش‌فرض؛ رفتار قبلی)، 'reported' = فقط چت‌هایی که گزارش بازِ در حال بررسی دارن (حفظ حریم خصوصی)
    moderatorChatAccess: { type: String, enum: ['all', 'reported'], default: 'all' },
    // حالت تعمیر: وقتی روشنه، همه (به‌جز ادمین) یه صفحه‌ی «در حال بروزرسانی» می‌بینن
    maintenanceMode: {
      enabled: { type: Boolean, default: false },
      message: { type: String, default: 'در حال بروزرسانی هستیم، لطفاً کمی بعد دوباره امتحان کنید.' },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Settings', settingsSchema);
