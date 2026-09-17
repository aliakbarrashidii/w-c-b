const Message = require('../models/Message');
const { getSettings } = require('./settings');

// توجه مهم: این پاک‌سازی فقط دیتابیس سرور رو تمیز می‌کنه. سرور برای کلاینت هیچ رویدادی
// برای این حذف نمی‌فرسته و کلاینت هم بهش گوش نمی‌ده — طبق تصمیم صریح کاربر، آرشیو خودِ
// گوشی (mobile-app/src/utils/localMessageDb.js) کاملاً مستقل از این نگهداریِ سمت سرورِ.
// یعنی این حذف فقط یعنی «سرور دیگه این پیام رو رله/بک‌آپ نمی‌کنه»، نه اینکه از گوشی هم بره.
async function purgeMatching(filter) {
  const result = await Message.deleteMany(filter);
  return result.deletedCount || 0;
}

async function runRetentionCleanup() {
  const settings = await getSettings();
  const now = Date.now();
  const retentionCutoff = new Date(now - settings.messageRetentionSec * 1000);
  const undeliveredCutoff = new Date(now - settings.undeliveredMaxWaitSec * 1000);

  // ۱) پیام‌های کامل تحویل‌داده‌شده که مدت نگهداری‌شون تموم شده
  const deliveredCount = await purgeMatching({ fullyDeliveredAt: { $ne: null, $lt: retentionCutoff } });
  // ۲) پیام‌هایی که هیچ‌وقت به همه نرسیدن و از سقف حداکثر انتظار هم گذشتن
  const undeliveredCount = await purgeMatching({ fullyDeliveredAt: null, createdAt: { $lt: undeliveredCutoff } });

  if (deliveredCount || undeliveredCount) {
    console.log(
      `[retention] حذف شد: ${deliveredCount} پیام تحویل‌شده‌ی منقضی، ${undeliveredCount} پیام نرسیده‌ی منقضی`
    );
  }
}

function startRetentionScheduler(intervalMs = 5 * 60 * 1000) {
  const tick = () => runRetentionCleanup().catch((err) => console.error('[retention] خطا:', err));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runRetentionCleanup, startRetentionScheduler };
