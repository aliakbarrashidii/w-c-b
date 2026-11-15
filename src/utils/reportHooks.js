const User = require('../models/User');
const { routeNewCase } = require('./caseRouting');
const { reportCountSince } = require('./caseStats');
const { getPolicy } = require('./moderationPolicy');

// بعد از ساختِ هر گزارش (کاربر یا AI): مسیریابی + «زیرنظرِ خودکار».
// زیرنظر فقط پرچمِ نمایشی است (moderation.underReview) و هیچ محدودیتِ خودکاری نمی‌گذارد؛ وگرنه گزارشِ انبوهِ مخرب سلاح می‌شد.
async function afterReportCreated(rec, accusedId) {
  try { await routeNewCase(rec, { category: rec.category }); } catch (e) { console.error('[routeNewCase]', e.message); }
  if (!accusedId) return;
  try {
    const { watch } = await getPolicy();
    if (!watch?.reports) return;
    const since = new Date(Date.now() - watch.days * 86400000);
    if ((await reportCountSince(accusedId, since)) >= watch.reports) {
      await User.updateOne({ _id: accusedId, 'moderation.underReview': { $ne: true } }, { $set: { 'moderation.underReview': true, 'moderation.reviewNote': 'زیرنظرِ خودکار: تعدادِ گزارش‌ها از حد گذشت' } });
    }
  } catch (e) { console.error('[watch]', e.message); }
}

module.exports = { afterReportCreated };
