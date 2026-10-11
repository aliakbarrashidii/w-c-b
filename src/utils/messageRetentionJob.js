const Message = require('../models/Message');
const { getSettings } = require('./settings');
const { unlinkIfUnreferenced } = require('./dataCleanup');

// توجه مهم: این پاک‌سازی فقط دیتابیس سرور رو تمیز می‌کنه. سرور برای کلاینت هیچ رویدادی
// برای این حذف نمی‌فرسته و کلاینت هم بهش گوش نمی‌ده — طبق تصمیم صریح کاربر، آرشیو خودِ
// گوشی (mobile-app/src/utils/localMessageDb.js) کاملاً مستقل از این نگهداریِ سمت سرورِ.
// یعنی این حذف فقط یعنی «سرور دیگه این پیام رو رله/بک‌آپ نمی‌کنه»، نه اینکه از گوشی هم بره.
async function purgeMatching(filter) {
  // فایلِ رسانه‌ی این پیام‌ها هم باید از دیسک پاک بشه (قبلاً فقط ردیف DB پاک می‌شد و فایل‌های uploads/ برای همیشه می‌موندن)
  const mediaUrls = await Message.distinct('mediaUrl', { ...filter, mediaUrl: { $ne: '' } });
  const result = await Message.deleteMany(filter);
  if (mediaUrls.length) await unlinkIfUnreferenced(mediaUrls).catch((e) => console.error('[retention] unlink:', e.message));
  return result.deletedCount || 0;
}

const MEDIA_TYPES = ['image', 'video', 'voice', 'video_note', 'file'];

async function runRetentionCleanup() {
  const settings = await getSettings();
  const now = Date.now();
  const defaultRetentionCutoff = new Date(now - settings.messageRetentionSec * 1000);
  const undeliveredCutoff = new Date(now - settings.undeliveredMaxWaitSec * 1000);

  // ۱) پیام‌های متنی (و هر نوعی که براش override جدا تعریف نشده) با نگهداریِ پیش‌فرض
  const typesWithOverride = MEDIA_TYPES.filter((t) => settings.mediaRetentionSec?.[t] != null);
  let deliveredCount = await purgeMatching({
    fullyDeliveredAt: { $ne: null, $lt: defaultRetentionCutoff },
    type: { $nin: typesWithOverride },
  });

  // ۲) هر نوع رسانه‌ای که نگهداریِ جداگانه براش تنظیم شده (مثلاً عکس ۱ روز، ویس ۳۰ روز)
  for (const t of typesWithOverride) {
    const cutoff = new Date(now - settings.mediaRetentionSec[t] * 1000);
    deliveredCount += await purgeMatching({ fullyDeliveredAt: { $ne: null, $lt: cutoff }, type: t });
  }

  // ۳) پیام‌هایی که هیچ‌وقت به همه نرسیدن و از سقف حداکثر انتظار هم گذشتن (این یکی مستقل از نوعه)
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
