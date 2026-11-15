// کارهای دوره‌ایِ یادگیری از تصمیم‌های ادمین: کالیبراسیونِ خودکارِ آستانه‌ها + پاک‌سازیِ نمونه‌های قدیمی
const TrainingSample = require('../models/TrainingSample');
const { getPolicy } = require('./moderationPolicy');
const { updateSettings } = require('./settings');
const { calibrateAll } = require('./calibration');

// apply=true ⇒ آستانه‌ها (policy.scopes[*][cat].minConfidence) واقعاً عوض می‌شوند؛ وگرنه فقط پیشنهاد برمی‌گردد
async function runCalibration({ apply = false } = {}) {
  const policy = await getPolicy();
  const t = policy.training;
  const samples = await TrainingSample.find({}).sort({ createdAt: -1 }).limit(20000).select('reportedCategory label confidence').lean();
  const current = {};
  for (const cat of new Set(samples.map((x) => x.reportedCategory))) {
    const on = ['private', 'group'].map((sc) => policy.scopes?.[sc]?.[cat]).find((c) => c?.enabled); // آستانه‌ی یکی از scopeهای «فعال»
    current[cat] = on?.minConfidence ?? policy.scopes?.private?.[cat]?.minConfidence ?? policy.scopes?.group?.[cat]?.minConfidence ?? 0.8;
  }
  const results = calibrateAll(samples, current, { targetPrecision: t.targetPrecision, minSamples: t.minSamples });
  const changes = [];
  if (apply) {
    const patch = {};
    for (const r of results) {
      if (!['adjust', 'precision_below_target'].includes(r.reason) || r.suggested === r.current) continue;
      let applied = false;
      for (const scope of ['private', 'group']) {
        if (policy.scopes?.[scope]?.[r.category]?.enabled) { patch[`moderationPolicy.scopes.${scope}.${r.category}.minConfidence`] = r.suggested; applied = true; } // فقط دسته‌هایی که ادمین فعال کرده
      }
      if (applied) changes.push({ category: r.category, from: r.current, to: r.suggested, reason: r.reason }); // فقط تغییری که واقعاً اعمال شد
    }
    if (Object.keys(patch).length) await updateSettings(patch);
  }
  return { results, changes, total: samples.length };
}

async function purgeOldSamples() {
  const { training } = await getPolicy();
  const cutoff = new Date(Date.now() - Math.max(1, training.retentionDays) * 86400000);
  return (await TrainingSample.deleteMany({ createdAt: { $lt: cutoff } })).deletedCount || 0;
}

async function dailyJob() {
  await purgeOldSamples();
  const { training } = await getPolicy();
  if (training.enabled && training.autoCalibrate) await runCalibration({ apply: true });
}

function startTrainingJobs(intervalMs = 24 * 60 * 60 * 1000) {
  const t = setInterval(() => dailyJob().catch((e) => console.error('[trainingJobs]', e.message)), intervalMs);
  t.unref?.();
  return t;
}

module.exports = { runCalibration, purgeOldSamples, dailyJob, startTrainingJobs };
