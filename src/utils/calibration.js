// کالیبراسیونِ آستانه‌ی اطمینان هر دسته از روی تصمیم‌های واقعیِ ادمین‌ها (خالص).
// samples: [{reportedCategory, label, confidence}]؛ label==reportedCategory ⇒ گزارشِ درست (تأیید)، label==='normal' ⇒ گزارشِ غلط (رد).
// فقط «دقت» (precision) قابل‌سنجی است، چون فقط مواردی که مدل فلگ کرده بررسی می‌شوند؛ «بازیابی» (recall) از این داده معلوم نمی‌شود.
// ⇒ آستانه فقط تا جایی پایین می‌آید که دقت ≥ هدف بماند، و هر بار حداکثر maxStep عوض می‌شود (بدونِ جهش‌های ناگهانی).
const FLOOR = 0.6; const CEIL = 0.97;

function precisionAt(samples, t) {
  const s = samples.filter((x) => (x.confidence ?? 0) >= t);
  const tp = s.filter((x) => x.label === x.reportedCategory).length;
  return { n: s.length, tp, precision: s.length ? tp / s.length : null };
}

// خروجی: {category, samples, current, suggested, precisionAtCurrent, reason}
function calibrateCategory(category, all, { current = 0.8, targetPrecision = 0.8, minSamples = 30, minAtThreshold = 15, maxStep = 0.1 } = {}) {
  const samples = all.filter((x) => x.reportedCategory === category && Number.isFinite(x.confidence));
  const base = { category, samples: samples.length, current, suggested: current, precisionAtCurrent: precisionAt(samples, current).precision };
  if (samples.length < minSamples) return { ...base, reason: 'not_enough_samples' };
  let best = null;
  for (let t = FLOOR; t <= CEIL + 1e-9; t += 0.01) {
    const r = precisionAt(samples, t);
    if (r.n >= minAtThreshold && r.precision >= targetPrecision) { best = Math.round(t * 100) / 100; break; } // کوچک‌ترین آستانه‌ای که دقتِ هدف را می‌دهد
  }
  if (best === null) return { ...base, suggested: Math.min(CEIL, Math.round(Math.min(current + maxStep, CEIL) * 100) / 100), reason: 'precision_below_target' }; // هیچ آستانه‌ای کافی نیست ⇒ سخت‌گیرتر شو (تا سقفِ گام)
  const stepped = Math.max(current - maxStep, Math.min(current + maxStep, best));
  return { ...base, suggested: Math.round(stepped * 100) / 100, reason: best === current ? 'ok' : 'adjust' };
}

function calibrateAll(samples, currentByCategory, opts = {}) {
  const cats = [...new Set(samples.map((s) => s.reportedCategory))];
  return cats.map((c) => calibrateCategory(c, samples, { ...opts, current: currentByCategory[c] ?? opts.current ?? 0.8 }));
}

module.exports = { precisionAt, calibrateCategory, calibrateAll, FLOOR, CEIL };
