// چک‌لیست مشترک: متنِ آیتم‌ها در content (در E2E رمزشده)، فقط «کدام ایندکس‌ها تیک خورده‌اند» روی سرور است.
// هر عضو چت می‌تواند تیک بزند/بردارد؛ تغییرِ همزمان = آخرین نوشتن برنده (idempotent).
const MAX_ITEMS = 30;

function parseIndex(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n < MAX_ITEMS ? n : null;
}

// done: [{index, by}] ← خروجی جدید، یا null اگر ایندکس نامعتبر است
function toggle(done, userId, index, wantDone) {
  const i = parseIndex(index);
  if (i === null) return null;
  const rest = (done || []).filter((d) => d.index !== i);
  return wantDone ? [...rest, { index: i, by: userId }].sort((a, b) => a.index - b.index) : rest;
}

function shapeDone(done) {
  return (done || []).map((d) => ({ index: d.index, by: String(d.by) }));
}

module.exports = { MAX_ITEMS, parseIndex, toggle, shapeDone };
