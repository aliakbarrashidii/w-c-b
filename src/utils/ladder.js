// پلکانِ محدودیت (خالص): از روی تعدادِ پرونده‌های «تأییدشده» تعیین می‌کند چه محدودیتی اعمال می‌شود.
// هر پله {confirmed, features[], days, category?}. پله‌ها به گروه تقسیم می‌شوند: «همه‌ی دسته‌ها» (بدونِ category) و هر دسته جدا؛
// از هر گروه «بالاترین پله‌ی رسیده» اعمال می‌شود (پله‌های گروه‌های مختلف با هم جمع می‌شوند).
// ادمین همیشه می‌تواند «بیشتر از پله» محدودیت بدهد (decide با features/days دستی)؛ این تابع فقط خودکار/پیش‌نمایش را می‌سازد.
function groupSteps(steps) {
  const groups = new Map();
  for (const st of steps || []) {
    const k = st.category || '';
    groups.set(k, [...(groups.get(k) || []), st]);
  }
  for (const [k, v] of groups) groups.set(k, [...v].sort((a, b) => a.confirmed - b.confirmed));
  return groups;
}

// countFor(category|'') ⇒ تعدادِ تأییدشده‌ها (برای '' کل). خروجی: [{category, count, step|null, next|null}] به‌ازای هر گروه
function planLadder(steps, countFor) {
  const out = [];
  for (const [category, list] of groupSteps(steps)) {
    const count = countFor(category);
    const reached = list.filter((s) => s.confirmed <= count);
    out.push({ category, count, step: reached.length ? reached[reached.length - 1] : null, next: list.find((s) => s.confirmed > count) || null });
  }
  return out;
}

// فقط ویژگی‌هایی که هنوز فعال نیستند (already = Set). خروجی: [{category, confirmed, features, days}]
function freshApplications(plan, already = new Set()) {
  const taken = new Set(already);
  const apps = [];
  for (const g of plan) {
    if (!g.step) continue;
    const features = g.step.features.filter((f) => !taken.has(f));
    if (!features.length) continue;
    features.forEach((f) => taken.add(f));
    apps.push({ category: g.category || undefined, confirmed: g.step.confirmed, features, days: g.step.days });
  }
  return apps;
}

// «یک پله بالاتر»: پله‌ی بعدیِ گروهِ همان دسته (یا گروهِ عمومی اگر دسته پله‌ای ندارد)؛ null = در بالاترین پله است
function higherStep(plan, category) {
  const g = plan.find((x) => x.category === category && x.next) || plan.find((x) => x.category === '' && x.next);
  return g ? { category: g.category || undefined, confirmed: g.next.confirmed, features: g.next.features, days: g.next.days } : null;
}

module.exports = { groupSteps, planLadder, freshApplications, higherStep };
