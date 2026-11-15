const test = require('node:test');
const assert = require('node:assert/strict');
const { precisionAt, calibrateCategory, calibrateAll } = require('../src/utils/calibration');

// n نمونه‌ی یک دسته با اطمینان‌های یکنواخت در [lo, hi]؛ احتمالِ درست‌بودن = pTrue(conf)
const gen = (cat, n, lo, hi, pTrue) => Array.from({ length: n }, (_, i) => {
  const c = lo + ((hi - lo) * i) / Math.max(1, n - 1);
  return { reportedCategory: cat, confidence: c, label: ((i * 7919) % 100) / 100 < pTrue(c) ? cat : 'normal' };
});

test('نمونه‌ی کم ⇒ هیچ تغییری (امن‌بودنِ پیش‌فرض)', () => {
  const r = calibrateCategory('violence_threat', gen('violence_threat', 10, 0.7, 1, () => 0), { current: 0.8 });
  assert.equal(r.suggested, 0.8); assert.equal(r.reason, 'not_enough_samples');
});
test('مدلی که فقط در اطمینانِ بالا درست است ⇒ آستانه بالا می‌رود (حداکثر یک گام)', () => {
  const s = gen('insult_hate', 200, 0.6, 1, (c) => (c >= 0.92 ? 0.95 : 0.3));
  const r = calibrateCategory('insult_hate', s, { current: 0.7, maxStep: 0.1 });
  assert.equal(r.reason, 'adjust'); assert.ok(r.suggested > 0.7 && r.suggested <= 0.8 + 1e-9); // 0.92 هدف است ولی فقط ۰٫۱ گام
  const r2 = calibrateCategory('insult_hate', s, { current: 0.8, maxStep: 0.1 });
  assert.ok(r2.suggested >= 0.9 && r2.suggested <= 0.92 + 1e-9);
});
test('مدلی که همه‌جا دقیق است ⇒ آستانه می‌تواند پایین بیاید (تا کفِ ۰٫۶ و یک گام)', () => {
  const s = gen('violence_threat', 200, 0.6, 1, () => 0.97);
  const r = calibrateCategory('violence_threat', s, { current: 0.9, maxStep: 0.1 });
  assert.ok(r.suggested < 0.9 && r.suggested >= 0.8 - 1e-9);
  assert.ok(calibrateCategory('violence_threat', s, { current: 0.62, maxStep: 0.1 }).suggested >= 0.6);
});
test('هیچ آستانه‌ای دقتِ هدف را نمی‌دهد ⇒ سخت‌گیرتر (یک گام)، نه خاموش و نه جهش', () => {
  const r = calibrateCategory('sexual_content', gen('sexual_content', 200, 0.6, 1, () => 0.2), { current: 0.8 });
  assert.equal(r.reason, 'precision_below_target'); assert.equal(r.suggested, 0.9);
  assert.equal(calibrateCategory('sexual_content', gen('sexual_content', 200, 0.6, 1, () => 0.2), { current: 0.95 }).suggested, 0.97); // سقف
});
test('آستانه‌ای که فقط چند نمونه بالایش مانده معتبر نیست (minAtThreshold)', () => {
  const s = [...gen('insult_hate', 60, 0.6, 0.8, () => 0.3), ...gen('insult_hate', 5, 0.99, 1, () => 1)]; // فقط ۵ نمونه‌ی بالای ۰٫۹۹ که همه درست‌اند
  const r = calibrateCategory('insult_hate', s, { current: 0.8 });
  assert.equal(r.reason, 'precision_below_target');
});
test('دسته‌ها جدا کالیبره می‌شوند؛ نمونه‌ی بدونِ اطمینان نادیده', () => {
  const s = [...gen('a', 60, 0.6, 1, () => 1), ...gen('b', 60, 0.6, 1, () => 0.1), { reportedCategory: 'a', label: 'a', confidence: null }];
  const out = calibrateAll(s, { a: 0.9, b: 0.7 });
  assert.equal(out.length, 2);
  assert.ok(out.find((x) => x.category === 'a').suggested < 0.9);
  assert.ok(out.find((x) => x.category === 'b').suggested > 0.7);
  assert.equal(precisionAt([], 0.5).precision, null);
});
