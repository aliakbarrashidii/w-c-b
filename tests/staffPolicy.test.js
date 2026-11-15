const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/utils/staffPolicy');

const T = P.resolveTiers();
const U = (role, level, extra = {}) => ({ _id: `${role}${level}${Math.random()}`.slice(0, 20), role, staff: level === undefined ? undefined : { level, ...extra } });

test('سازگاری با قبل: admin بدونِ staff = مدیر اصلی؛ moderator = ردیفِ ۳؛ user = هیچ', () => {
  assert.equal(P.levelOf({ role: 'admin' }), 0);
  assert.equal(P.levelOf({ role: 'moderator' }), 3);
  assert.equal(P.levelOf({ role: 'user' }), null);
  assert.equal(P.levelOf({ role: 'moderator', staff: { level: 2 } }), 2);
  assert.equal(P.levelOf(null), null);
  assert.equal(P.can({ role: 'admin' }, 'staff.manage', T), true);
  assert.equal(P.can({ role: 'user' }, 'cases.decide', T), false);
});
test('ردیف‌های پیش‌فرض: معاون همه به‌جز کلیدها/مدل‌ها؛ ناظر پایین محدود', () => {
  const dep = U('admin', 1); const sen = U('moderator', 2); const jun = U('moderator', 3);
  assert.equal(P.can(dep, 'staff.manage', T), true);
  assert.equal(P.can(dep, 'keys.manage', T), false);
  assert.equal(P.can(sen, 'cases.confirm', T), true);
  assert.equal(P.can(jun, 'cases.confirm', T), false);
  assert.equal(P.can(jun, 'chats.browse', T), false);
  assert.equal(P.can(jun, 'context.full', T), false);
});
test('grant/revoke فردی روی ردیف؛ و ردیفِ ۰ قابل‌کاهش نیست', () => {
  const j = U('moderator', 3, { grant: ['cases.confirm', 'bogus'], revoke: ['users.view_stats'] });
  assert.equal(P.can(j, 'cases.confirm', T), true);
  assert.equal(P.can(j, 'bogus', T), false);
  assert.equal(P.can(j, 'users.view_stats', T), false);
  assert.equal(P.can(U('admin', 0, { revoke: ['staff.manage'] }), 'staff.manage', T), true);
});
test('resolveTiers: ادغامِ تنظیمات؛ ردیفِ ۰ ثابت؛ ورودیِ خراب نادیده', () => {
  const t = P.resolveTiers([
    { level: 0, name: 'x', permissions: [], caseScope: 'assigned', context: { full: false } },
    { level: 3, name: ' ناظر جدید ', permissions: ['cases.decide', 'zzz'], context: { before: 999, after: -4 }, maxRestrictDays: 99999 },
    { level: 5, name: 'ردیف تازه' }, null, 5, { level: 'x' },
  ]);
  const t0 = t.find((x) => x.level === 0); const t3 = t.find((x) => x.level === 3); const t5 = t.find((x) => x.level === 5);
  assert.deepEqual([t0.permissions, t0.caseScope, t0.context.full], [['*'], 'all', true]);
  assert.equal(t3.name, 'ناظر جدید'); assert.deepEqual(t3.permissions, ['cases.decide']);
  assert.deepEqual([t3.context.before, t3.context.after, t3.maxRestrictDays], [200, 0, 3650]);
  assert.equal(t5.caseScope, 'assigned');
  assert.deepEqual(t.map((x) => x.level), [0, 1, 2, 3, 5]);
});
test('sanitizeTiers: ردیفِ ۰ الزامی، تکراری/ناشناخته/* برای غیرصفر رد', () => {
  assert.ok(P.sanitizeTiers([{ level: 0 }, { level: 1 }]).tiers);
  for (const bad of [[], null, [{ level: 1 }], [{ level: 0 }, { level: 0 }], [{ level: 0 }, { level: 10 }], [{ level: 0 }, { level: 2, permissions: ['*'] }], [{ level: 0 }, { level: 2, permissions: ['nope'] }], [{ level: 0 }, { level: 1.5 }]]) {
    assert.ok(P.sanitizeTiers(bad).error, JSON.stringify(bad));
  }
  assert.equal(P.sanitizeTiers([{ level: 0 }, { level: 2 }]).tiers.some((t) => t.level === 3), false);
});
test('canActOnStaff: فقط ارشدتر روی پایین‌تر؛ هرگز روی خود/هم‌رده؛ کاربر عادی هدف آزاد', () => {
  const owner = U('admin', 0); const dep = U('admin', 1); const sen = U('moderator', 2); const jun = U('moderator', 3); const user = { _id: 'u', role: 'user' };
  assert.equal(P.canActOnStaff(owner, dep, T), true);
  assert.equal(P.canActOnStaff(owner, jun, T), true);
  assert.equal(P.canActOnStaff(dep, jun, T), true);
  assert.equal(P.canActOnStaff(sen, jun, T), false);
  assert.equal(P.canActOnStaff(jun, sen, T), false);
  assert.equal(P.canActOnStaff(jun, user, T), true);
  assert.equal(P.canActOnStaff(owner, owner, T), false);
  assert.equal(P.canActOnStaff(U('moderator', 3), U('moderator', 3), T), false);
  assert.equal(P.canActOnStaff(user, user, T), false);
});
test('دیدنِ پرونده: all / below / assigned', () => {
  const me = { _id: 'me', role: 'moderator', staff: { level: 2 } };
  const jun = { _id: 'j', role: 'moderator', staff: { level: 3 } };
  const owner = { _id: 'o', role: 'admin' };
  const rec = (tier, assignedTo = null) => ({ tier, assignedTo });
  assert.equal(P.mayViewCase(owner, rec(3), T), true);
  assert.equal(P.mayViewCase(me, rec(2), T), true);
  assert.equal(P.mayViewCase(me, rec(3), T), true);
  assert.equal(P.mayViewCase(me, rec(1), T), false);
  assert.equal(P.mayViewCase(me, rec(1, 'me'), T), true);
  assert.equal(P.mayViewCase(jun, rec(3), T), false);
  assert.equal(P.mayViewCase(jun, rec(3, 'j'), T), true);
  assert.equal(P.mayViewCase(jun, rec(3, { _id: 'j' }), T), true);
  assert.equal(P.mayViewCase({ role: 'user' }, rec(0), T), false);
  assert.equal(P.caseListFilter(owner, T), null);
  assert.deepEqual(P.caseListFilter(jun, T), { assignedTo: 'j' });
  assert.deepEqual(P.caseListFilter(me, T), { $or: [{ assignedTo: 'me' }, { tier: { $gte: 2 } }] });
});
test('contextWindowFor: مدیر کامل؛ ناظر پنجره‌ی کوچک؛ با context.full فردی کامل', () => {
  assert.deepEqual(P.contextWindowFor({ role: 'admin' }, T), { full: true, before: 200, after: 200 });
  assert.deepEqual(P.contextWindowFor({ role: 'moderator', staff: { level: 3 } }, T), { full: false, before: 5, after: 5 });
  assert.equal(P.contextWindowFor({ role: 'moderator', staff: { level: 3, grant: ['context.full'] } }, T).full, true);
  assert.deepEqual(P.contextWindowFor({ role: 'user' }, T), { full: false, before: 0, after: 0 });
});
test('مسیریابی: پیش‌فرض همه برای مدیر اصلی؛ دسته‌ها؛ SLA؛ ردیفِ بالاتر', () => {
  const r0 = P.resolveRouting(undefined);
  assert.equal(P.initialTierFor('violence_threat', r0), 0);
  const r = P.resolveRouting({ initialTier: 3, byCategory: { violence_threat: 1, 'bad key!': 2, insult_hate: 99 }, escalateAfterMin: { 3: 30, 2: 0, x: 5 }, assignment: 'round_robin', onlineOnly: false });
  assert.equal(P.initialTierFor('violence_threat', r), 1);
  assert.equal(P.initialTierFor('sexual_harassment', r), 3);
  assert.equal(P.initialTierFor('insult_hate', r), 9);
  assert.deepEqual(Object.keys(r.byCategory).sort(), ['insult_hate', 'violence_threat']);
  assert.deepEqual(r.escalateAfterMin, { 3: 30, 2: 0 });
  assert.equal(r.assignment, 'round_robin'); assert.equal(r.onlineOnly, false);
  const now = 1_000_000;
  assert.equal(P.dueAtFor(3, r, now).getTime(), now + 30 * 60000);
  assert.equal(P.dueAtFor(2, r, now), null); assert.equal(P.dueAtFor(0, r, now), null);
  assert.equal(P.nextTierUp(3, T), 2); assert.equal(P.nextTierUp(1, T), 0); assert.equal(P.nextTierUp(0, T), null);
});
test('pickAssignee: فقط آنلاین، کم‌بارترین، چرخشی، قطعی', () => {
  const c = [{ id: 'b', online: true, load: 2 }, { id: 'a', online: true, load: 2 }, { id: 'c', online: false, load: 0 }, { id: 'd', online: true, load: 5 }];
  assert.equal(P.pickAssignee(c, { assignment: 'least_loaded' }), 'a');
  assert.equal(P.pickAssignee(c, { assignment: 'least_loaded', cursor: 1 }), 'b');
  assert.equal(P.pickAssignee(c, { assignment: 'round_robin', cursor: 2 }), 'd');
  assert.equal(P.pickAssignee(c, { assignment: 'least_loaded', onlineOnly: false }), 'c');
  assert.equal(P.pickAssignee([{ id: 'x', online: false, load: 0 }], {}), null);
  assert.equal(P.pickAssignee([], {}), null); assert.equal(P.pickAssignee(undefined, {}), null);
});
