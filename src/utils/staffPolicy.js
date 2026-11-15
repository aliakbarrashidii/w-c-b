// سطح‌بندیِ ادمین‌ها (خالص و قابل تست). level کمتر = ارشدتر: ۰ = مدیر اصلی، ۱ = معاون، ۲.. = ناظرها (تعدادِ ردیف‌ها قابل‌تنظیم).
// سازگاری با قبل: role='admin' بدونِ staff.level ⇒ مدیر اصلی (۰)؛ role='moderator' بدونِ staff.level ⇒ پایین‌ترین ردیفِ پیش‌فرض (۳).
const PERMISSIONS = {
  'cases.decide': 'تصمیم روی پرونده (رد / زیرنظر)',
  'cases.confirm': 'تأییدِ تخلف (اعمال محدودیت و ثبت در پرونده‌ی کاربر)',
  'cases.escalate': 'ارجاع به ردیفِ بالاتر',
  'cases.reassign': 'واگذاری پرونده به ناظرِ دیگر',
  'cases.claim': 'برداشتنِ پرونده‌ی بدون‌مسئول از صفِ ردیف',
  'context.full': 'دیدنِ بافتِ کاملِ چتِ گزارش‌شده (نه فقط پنجره‌ی اطرافِ پیام)',
  'chats.browse': 'مرورِ همه‌ی چت‌ها / جستجوی پیام‌ها (خارج از پرونده)',
  'reports.legacy_lists': 'لیست‌های قدیمیِ گزارش‌ها (خام)',
  'users.view_stats': 'دیدنِ آمارِ گزارش‌های هر کاربر',
  'users.restrict': 'اعمال/برداشتنِ محدودیتِ موقت',
  'users.restrict_permanent': 'محدودیتِ بدونِ تاریخ پایان / بن',
  'users.moderate_staff': 'اقدام روی حسابِ ادمین‌های پایین‌تر',
  'staff.view_board': 'دیدنِ تابلوی ادمین‌ها (آنلاین/بار کاری)',
  'staff.manage': 'مدیریتِ ادمین‌ها (افزودن/تغییر ردیف/دسترسی)',
  'routing.edit': 'تنظیمِ مسیرِ گزارش‌ها و ردیف‌ها',
  'policy.edit': 'تغییرِ سیاستِ نظارت (آستانه‌ها، پلکان محدودیت)',
  'models.manage': 'آپلود/حذفِ مدل‌های هوش مصنوعی',
  'keys.manage': 'مدیریتِ کلیدهای رمزنگاریِ ردیف‌ها',
};
const ALL = Object.keys(PERMISSIONS);
const OWNER_ONLY = ['staff.manage_owner'];
const MAX_LEVEL = 9;
const LEGACY_MODERATOR_LEVEL = 3;

const DEFAULT_TIERS = [
  { level: 0, name: 'مدیر اصلی', caseScope: 'all', context: { full: true, before: 200, after: 200 }, maxRestrictDays: 0, permissions: ['*'] },
  // معاون: همه‌چیز مگر آنچه مدیر اصلی برمی‌دارد
  { level: 1, name: 'معاون', caseScope: 'all', context: { full: true, before: 200, after: 200 }, maxRestrictDays: 0, permissions: [...ALL.filter((p) => !['keys.manage', 'models.manage'].includes(p))] },
  { level: 2, name: 'ناظر ارشد', caseScope: 'below', context: { full: false, before: 15, after: 15 }, maxRestrictDays: 30, permissions: ['cases.decide', 'cases.confirm', 'cases.escalate', 'cases.reassign', 'cases.claim', 'users.view_stats', 'users.restrict', 'staff.view_board'] },
  { level: 3, name: 'ناظر', caseScope: 'assigned', context: { full: false, before: 5, after: 5 }, maxRestrictDays: 3, permissions: ['cases.decide', 'cases.escalate', 'cases.claim', 'users.view_stats'] },
];

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : d; };

// ردیف‌های ذخیره‌شده (تنظیمات) روی پیش‌فرض ادغام می‌شوند؛ ردیفِ ۰ همیشه همه‌ی دسترسی‌ها را دارد و قابل‌کاهش نیست.
function resolveTiers(stored) {
  const byLevel = new Map(DEFAULT_TIERS.map((t) => [t.level, { ...t, context: { ...t.context }, permissions: [...t.permissions] }]));
  for (const t of Array.isArray(stored) ? stored : []) {
    if (!isPlain(t)) continue;
    const level = clamp(t.level, 0, MAX_LEVEL, null);
    if (level === null) continue;
    const base = byLevel.get(level) || { level, name: `ردیف ${level}`, caseScope: 'assigned', context: { full: false, before: 5, after: 5 }, maxRestrictDays: 3, permissions: [] };
    const next = { ...base, context: { ...base.context } };
    if (typeof t.name === 'string' && t.name.trim()) next.name = t.name.trim().slice(0, 40);
    if (['all', 'below', 'assigned'].includes(t.caseScope)) next.caseScope = t.caseScope;
    if (isPlain(t.context)) {
      if (typeof t.context.full === 'boolean') next.context.full = t.context.full;
      next.context.before = clamp(t.context.before, 0, 200, next.context.before);
      next.context.after = clamp(t.context.after, 0, 200, next.context.after);
    }
    next.maxRestrictDays = clamp(t.maxRestrictDays, 0, 3650, next.maxRestrictDays);
    if (Array.isArray(t.permissions)) next.permissions = [...new Set(t.permissions.filter((p) => p === '*' || ALL.includes(p)))];
    byLevel.set(level, next);
  }
  const zero = byLevel.get(0);
  zero.name = zero.name || 'مدیر اصلی'; zero.permissions = ['*']; zero.caseScope = 'all'; zero.context = { full: true, before: 200, after: 200 }; zero.maxRestrictDays = 0;
  return [...byLevel.values()].sort((a, b) => a.level - b.level);
}

// ورودیِ PUT /staff/tiers را اعتبارسنجی می‌کند؛ خروجی آماده‌ی ذخیره یا { error }.
function sanitizeTiers(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_LEVEL + 1) return { error: 'فهرست ردیف‌ها نامعتبر است' };
  const levels = new Set();
  for (const t of input) {
    if (!isPlain(t) || !Number.isInteger(t.level) || t.level < 0 || t.level > MAX_LEVEL) return { error: 'شماره‌ی ردیف نامعتبر است (۰ تا ۹)' };
    if (levels.has(t.level)) return { error: 'شماره‌ی ردیف تکراری است' };
    levels.add(t.level);
    if (Array.isArray(t.permissions) && t.permissions.some((p) => p !== '*' && !ALL.includes(p))) return { error: `دسترسیِ ناشناخته: ${t.permissions.find((p) => p !== '*' && !ALL.includes(p))}` };
    if (t.level > 0 && Array.isArray(t.permissions) && t.permissions.includes('*')) return { error: 'فقط ردیفِ ۰ همه‌ی دسترسی‌ها (*) را دارد' };
  }
  if (!levels.has(0)) return { error: 'ردیفِ ۰ (مدیر اصلی) باید باشد' };
  return { tiers: resolveTiers(input).filter((t) => levels.has(t.level)) };
}

function levelOf(user) {
  if (!user) return null;
  const l = user.staff?.level;
  if (Number.isInteger(l) && l >= 0) return l;
  if (user.role === 'admin') return 0;
  if (user.role === 'moderator') return LEGACY_MODERATOR_LEVEL;
  return null;
}
const tierOf = (user, tiers) => tiers.find((t) => t.level === levelOf(user)) || null;

function permissionsOf(user, tiers) {
  const t = tierOf(user, tiers);
  if (!t) return new Set();
  if (t.permissions.includes('*')) return new Set(['*']);
  const set = new Set(t.permissions);
  for (const p of user.staff?.grant || []) if (ALL.includes(p)) set.add(p);
  for (const p of user.staff?.revoke || []) set.delete(p);
  return set;
}
function can(user, perm, tiers) { const p = permissionsOf(user, tiers); return p.has('*') || p.has(perm); }

// آیا actor مجاز است روی حسابِ staffِ target اقدام کند؟ فقط ارشدتر روی پایین‌تر؛ مدیر اصلی روی همه‌ی غیر-خودش‌ها.
function canActOnStaff(actor, target, tiers) {
  const a = levelOf(actor); const b = levelOf(target);
  if (b === null) return a !== null;
  if (a === null) return false;
  if (String(actor._id || actor.id) === String(target._id || target.id)) return false;
  return a < b && (a === 0 || can(actor, 'users.moderate_staff', tiers));
}

// دیدنِ پرونده بر اساس caseScope ردیف: all = همه | below = ردیفِ خودم و پایین‌تر + واگذارشده به خودم | assigned = فقط واگذارشده به خودم
function mayViewCase(user, rec, tiers) {
  const t = tierOf(user, tiers); if (!t) return false;
  const me = String(user._id || user.id);
  if (rec.assignedTo && String(rec.assignedTo._id || rec.assignedTo) === me) return true;
  if (t.caseScope === 'all') return true;
  if (t.caseScope === 'below') return (rec.tier ?? 0) >= t.level;
  return false;
}
// فیلترِ کوئری معادلِ mayViewCase (برای فهرست)؛ null = بدون فیلتر
function caseListFilter(user, tiers) {
  const t = tierOf(user, tiers); if (!t) return { _id: null };
  const me = user._id || user.id;
  if (t.caseScope === 'all') return null;
  if (t.caseScope === 'below') return { $or: [{ assignedTo: me }, { tier: { $gte: t.level } }] };
  return { assignedTo: me };
}
// پنجره‌ی بافتِ سمتِ سرور برای کاربر: full ⇒ تا ۲۰۰؛ وگرنه n قبل/بعد
function contextWindowFor(user, tiers) {
  const t = tierOf(user, tiers);
  if (!t) return { full: false, before: 0, after: 0 };
  const full = t.context.full || can(user, 'context.full', tiers);
  return { full, before: full ? 200 : t.context.before, after: full ? 200 : t.context.after };
}

// ---- مسیریابی ----
const DEFAULT_ROUTING = { initialTier: 0, byCategory: {}, escalateAfterMin: {}, assignment: 'least_loaded', onlineOnly: true };
function resolveRouting(stored) {
  const r = { ...DEFAULT_ROUTING, byCategory: {}, escalateAfterMin: {} };
  if (!isPlain(stored)) return r;
  r.initialTier = clamp(stored.initialTier, 0, MAX_LEVEL, 0);
  if (isPlain(stored.byCategory)) for (const [k, v] of Object.entries(stored.byCategory)) if (/^[a-z0-9_]{1,40}$/i.test(k)) r.byCategory[k] = clamp(v, 0, MAX_LEVEL, r.initialTier);
  if (isPlain(stored.escalateAfterMin)) for (const [k, v] of Object.entries(stored.escalateAfterMin)) if (/^\d$/.test(k)) r.escalateAfterMin[k] = clamp(v, 0, 60 * 24 * 14, 0);
  if (['least_loaded', 'round_robin'].includes(stored.assignment)) r.assignment = stored.assignment;
  if (typeof stored.onlineOnly === 'boolean') r.onlineOnly = stored.onlineOnly;
  return r;
}
const initialTierFor = (category, routing) => (routing.byCategory?.[category] ?? routing.initialTier ?? 0);
function dueAtFor(tier, routing, now = Date.now()) {
  const min = routing.escalateAfterMin?.[String(tier)] || 0;
  return min > 0 && tier > 0 ? new Date(now + min * 60 * 1000) : null;
}
function nextTierUp(current, tiers) {
  const up = tiers.filter((t) => t.level < current).map((t) => t.level);
  return up.length ? Math.max(...up) : null;
}
// انتخابِ مسئول از میان نامزدها: [{id, online, load}]
function pickAssignee(candidates, { assignment = 'least_loaded', onlineOnly = true, cursor = 0 } = {}) {
  const pool = (candidates || []).filter((c) => !onlineOnly || c.online).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (!pool.length) return null;
  if (assignment === 'round_robin') return pool[cursor % pool.length].id;
  const minLoad = Math.min(...pool.map((c) => c.load));
  const least = pool.filter((c) => c.load === minLoad);
  return least[cursor % least.length].id;
}

module.exports = {
  PERMISSIONS, ALL_PERMISSIONS: ALL, OWNER_ONLY, DEFAULT_TIERS, MAX_LEVEL, LEGACY_MODERATOR_LEVEL,
  resolveTiers, sanitizeTiers, levelOf, tierOf, permissionsOf, can, canActOnStaff, mayViewCase, caseListFilter, contextWindowFor,
  DEFAULT_ROUTING, resolveRouting, initialTierFor, dueAtFor, nextTierUp, pickAssignee,
};
