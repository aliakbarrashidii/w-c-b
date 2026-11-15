const test = require('node:test');
const assert = require('node:assert/strict');
const { planLadder, freshApplications, higherStep } = require('../src/utils/ladder');
const { DEFAULT_POLICY } = require('../src/utils/moderationPolicy');
const S = DEFAULT_POLICY.escalation;
const counts = (total, by = {}) => (c) => (c === '' ? total : by[c] || 0);

test('هر گروه بالاترین پله‌ی رسیده را می‌گیرد؛ گروه‌ها جمع می‌شوند', () => {
  const plan = planLadder(S, counts(1, { violence_threat: 1 }));
  const apps = freshApplications(plan);
  const feats = new Set(apps.flatMap((a) => a.features));
  assert.ok(feats.has('send_media') && feats.has('calls') && feats.has('new_chats')); // عمومی(۱) + تهدید(۱)
  assert.equal(apps.find((a) => a.category === 'violence_threat').days, 7);
});
test('دسته‌ی جدی زودتر و سنگین‌تر از دسته‌ی کوچک می‌شود', () => {
  const at = (cat, n) => freshApplications(planLadder(S, counts(n, { [cat]: n })));
  assert.ok(at('violence_threat', 1).some((a) => a.category === 'violence_threat'));
  assert.ok(!at('insult_hate', 1).some((a) => a.category === 'insult_hate')); // توهینِ اول: فقط پلهٔ عمومی
  assert.ok(at('insult_hate', 3).some((a) => a.category === 'insult_hate'));
});
test('ویژگیِ از قبل فعال دوباره اعمال نمی‌شود؛ بدونِ پله‌ی تازه ⇒ []', () => {
  const plan = planLadder(S, counts(1, { violence_threat: 1 }));
  const all = new Set(freshApplications(plan).flatMap((a) => a.features));
  assert.deepEqual(freshApplications(plan, all), []);
  assert.deepEqual(freshApplications(planLadder(S, counts(0)), new Set()), []);
});
test('پله‌ها در بالاترین سطح قفل نمی‌شوند: بالاتر از بالاترین پله‌ی رسیده همان می‌ماند', () => {
  const plan = planLadder(S, counts(99, { violence_threat: 99 }));
  const top = plan.find((g) => g.category === 'violence_threat');
  assert.equal(top.step.confirmed, Math.max(...S.filter((s) => s.category === 'violence_threat').map((s) => s.confirmed)));
  assert.equal(top.next, null);
});
test('higherStep: پله‌ی بعدیِ همان دسته؛ بدونِ پله‌ی دسته ⇒ عمومی؛ بالاترین ⇒ null', () => {
  const plan = planLadder(S, counts(1, { violence_threat: 1 }));
  const h = higherStep(plan, 'violence_threat');
  assert.equal(h.category, 'violence_threat'); assert.equal(h.confirmed, 2);
  assert.ok(h.features.length > freshApplications(planLadder(S, counts(1, { violence_threat: 1 }))).find((a) => a.category === 'violence_threat').features.length - 1);
  assert.equal(higherStep(planLadder(S, counts(1, {})), 'unknown_cat').category, undefined); // عمومی
  assert.equal(higherStep(planLadder(S, counts(99, { violence_threat: 99 })), 'violence_threat'), null);
});
test('طراحیِ پیش‌فرض: پله‌ها صعودی، مدت‌ها غیرکاهشی، ویژگی‌ها معتبر، و هیچ پلهٔ خودکاری دائمی نیست', () => {
  const { FEATURES } = require('../src/utils/restrictions');
  for (const [cat, list] of require('../src/utils/ladder').groupSteps(S)) {
    let prevDays = 0; let prevN = 0; let prevFeatSize = 0;
    for (const st of list) {
      assert.ok(st.confirmed > prevN, `${cat}: confirmed صعودی`); prevN = st.confirmed;
      assert.ok(st.days > 0, `${cat}: پلهٔ خودکارِ دائمی ممنوع (دائمی فقط تصمیمِ دستیِ ادمین)`);
      assert.ok(st.days >= prevDays, `${cat}: مدت کم نشود`); prevDays = st.days;
      assert.ok(st.features.every((f) => FEATURES[f]), `${cat}: ویژگی نامعتبر`);
      assert.ok(st.features.length >= prevFeatSize || st.days > 0, `${cat}`); prevFeatSize = st.features.length;
      assert.ok(!st.features.includes('file_reports') && !st.features.includes('profile_edit'), `${cat}: ثبت گزارش/ویرایش پروفایل جزو پلکان نیست`);
    }
  }
});
