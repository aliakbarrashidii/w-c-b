// مسیریابیِ پرونده‌ها بین ردیف‌های ادمین: ردیفِ اولیه، مسئولِ آنلاین/کم‌بار، ارجاعِ دستی و خودکار (SLA)، تابلوی بار کاری
const User = require('../models/User');
const Report = require('../models/Report');
const EncryptedReport = require('../models/EncryptedReport');
const { getSettings } = require('./settings');
const { resolveTiers, resolveRouting, levelOf, initialTierFor, dueAtFor, nextTierUp, pickAssignee } = require('./staffPolicy');

const OPEN = ['pending', 'under_review'];
const MODELS = [Report, EncryptedReport];
let rrCursor = 0;

async function loadCtx() {
  const s = await getSettings();
  return { tiers: resolveTiers(s.staffTiers), routing: resolveRouting(s.moderationRouting) };
}

// همه‌ی ادمین‌ها/ناظرهای فعال با ردیفشان
async function activeStaff() {
  const users = await User.find({ role: { $in: ['admin', 'moderator'] }, status: { $nin: ['banned', 'deleted'] } }).select('role staff isOnline status suspendedUntil');
  const now = new Date();
  return users
    .filter((u) => !(u.status === 'suspended' && u.suspendedUntil && u.suspendedUntil > now))
    .map((u) => ({ user: u, level: levelOf(u) }))
    .filter((x) => x.level !== null);
}

async function loadOf(staffId) {
  const [a, b] = await Promise.all([
    Report.countDocuments({ assignedTo: staffId, status: { $in: OPEN } }),
    EncryptedReport.countDocuments({ assignedTo: staffId, status: { $in: OPEN } }),
  ]);
  return a + b;
}

// نزدیک‌ترین ردیفِ ≤ desired (ارشدتر یا برابر) که حداقل یک ادمینِ فعال دارد؛ ردیفِ ۰ همیشه نهایی است
function resolveTierWithStaff(desired, staff) {
  let t = desired;
  while (t > 0 && !staff.some((s) => s.level === t)) t -= 1;
  return t;
}

async function assignTo(rec, tier, staff, routing) {
  const atLevel = staff.filter((s) => s.level === tier);
  const candidates = await Promise.all(atLevel.map(async (s) => ({ id: String(s.user._id), online: !!s.user.isOnline, load: await loadOf(s.user._id) })));
  rrCursor += 1;
  let id = pickAssignee(candidates, { assignment: routing.assignment, onlineOnly: routing.onlineOnly, cursor: rrCursor });
  // هیچ‌کس آنلاین نیست: پرونده در صفِ ردیف می‌ماند (بدون مسئول) تا اولین ناظرِ آنلاین «بردارد» یا SLA ارجاعش بدهد
  rec.tier = tier;
  rec.assignedTo = id || null;
  rec.assignedAt = id ? new Date() : null;
  rec.dueAt = dueAtFor(tier, routing);
  return id;
}

async function routeNewCase(rec, { category } = {}) {
  const { routing } = await loadCtx();
  const staff = await activeStaff();
  const tier = resolveTierWithStaff(initialTierFor(category || rec.category, routing), staff);
  await assignTo(rec, tier, staff, routing);
  await rec.save();
  return rec;
}

// ارجاع به ردیفِ بالاتر (نزدیک‌ترینِ دارای ادمین). از ردیفِ ۰ ممکن نیست.
async function escalate(rec, { by = null, reason = '', auto = false } = {}) {
  const { tiers, routing } = await loadCtx();
  const staff = await activeStaff();
  let to = nextTierUp(rec.tier ?? 0, tiers);
  while (to !== null && to > 0 && !staff.some((s) => s.level === to)) to = nextTierUp(to, tiers);
  if (to === null) return { ok: false, error: 'پرونده در بالاترین ردیف است' };
  const from = rec.tier ?? 0;
  rec.escalations.push({ from, to, by, reason: String(reason || '').slice(0, 300), auto, at: new Date() });
  await assignTo(rec, to, staff, routing);
  await rec.save();
  return { ok: true, from, to };
}

async function sweepEscalations(now = new Date()) {
  let n = 0;
  for (const Model of MODELS) {
    const due = await Model.find({ status: { $in: OPEN }, dueAt: { $ne: null, $lte: now }, tier: { $gt: 0 } }).limit(100);
    for (const rec of due) {
      try { const r = await escalate(rec, { reason: 'پایانِ مهلتِ رسیدگی', auto: true }); if (r.ok) n += 1; else { rec.dueAt = null; await rec.save(); } } catch { /* ادامه با بقیه */ }
    }
  }
  return n;
}

// تابلو: برای هر ردیف: تعدادِ ادمین، آنلاین، بارِ کل، پرونده‌های بدونِ مسئول
async function board() {
  const { tiers } = await loadCtx();
  const staff = await activeStaff();
  const open = await Promise.all(MODELS.map((M) => M.find({ status: { $in: OPEN } }).select('tier assignedTo')));
  const cases = open.flat();
  return tiers.map((t) => {
    const members = staff.filter((s) => s.level === t.level);
    const here = cases.filter((c) => (c.tier ?? 0) === t.level);
    return {
      level: t.level, name: t.name,
      total: members.length, online: members.filter((m) => m.user.isOnline).length,
      open: here.length, unassigned: here.filter((c) => !c.assignedTo).length,
      members: members.map((m) => ({ id: m.user._id, online: !!m.user.isOnline, load: here.filter((c) => String(c.assignedTo) === String(m.user._id)).length })),
    };
  });
}

function startEscalationSweeper(intervalMs = 60 * 1000) {
  const t = setInterval(() => sweepEscalations().catch(() => {}), intervalMs);
  t.unref?.();
  return t;
}

module.exports = { routeNewCase, escalate, sweepEscalations, board, activeStaff, startEscalationSweeper, resolveTierWithStaff, OPEN };
