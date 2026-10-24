const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/utils/dndCore');
const P = require('../src/utils/pushPolicy');
// 2026-10-19 (دوشنبه) ۲۳:۳۰ UTC
const at = (iso) => Date.parse(iso);
const IR = 210; // ایران UTC+3:30

test('off / unset / garbage are never active', () => {
  for (const d of [undefined, null, {}, { mode: 'off' }, { mode: 'weird' }, { mode: 'schedule' }]) assert.equal(D.isDndActive(d, at('2026-10-19T10:00:00Z')), false);
});
test('until: active before the deadline, not after', () => {
  const now = at('2026-10-19T10:00:00Z');
  assert.equal(D.isDndActive({ mode: 'until', until: now + 1000 }, now), true);
  assert.equal(D.isDndActive({ mode: 'until', until: now }, now), false);
  assert.equal(D.isDndActive({ mode: 'until', until: now - 1 }, now), false);
});
test('same-day schedule window respects days and boundaries', () => {
  const dnd = { mode: 'schedule', schedule: { from: '09:00', to: '17:00', days: [1, 2, 3], tzOffsetMin: 0 } }; // دوشنبه تا چهارشنبه
  assert.equal(D.isDndActive(dnd, at('2026-10-19T09:00:00Z')), true);   // دوشنبه ۰۹:۰۰ (شروع، شامل)
  assert.equal(D.isDndActive(dnd, at('2026-10-19T16:59:00Z')), true);
  assert.equal(D.isDndActive(dnd, at('2026-10-19T17:00:00Z')), false);  // پایان، شامل نیست
  assert.equal(D.isDndActive(dnd, at('2026-10-19T08:59:00Z')), false);
  assert.equal(D.isDndActive(dnd, at('2026-10-22T10:00:00Z')), false);  // پنجشنبه: روز نیست
});
test('overnight window belongs to the day it started', () => {
  const dnd = { mode: 'schedule', schedule: { from: '22:00', to: '07:00', days: [1], tzOffsetMin: 0 } }; // فقط شب‌های دوشنبه
  assert.equal(D.isDndActive(dnd, at('2026-10-19T23:30:00Z')), true);   // دوشنبه شب
  assert.equal(D.isDndActive(dnd, at('2026-10-20T06:59:00Z')), true);   // سه‌شنبه صبح (ادامه‌ی شب دوشنبه)
  assert.equal(D.isDndActive(dnd, at('2026-10-20T07:00:00Z')), false);
  assert.equal(D.isDndActive(dnd, at('2026-10-20T23:30:00Z')), false);  // سه‌شنبه شب: روز انتخاب نیست
  assert.equal(D.isDndActive(dnd, at('2026-10-19T06:00:00Z')), false);  // دوشنبه صبح: ادامه‌ی یکشنبه شب است، یکشنبه انتخاب نیست
});
test('timezone offset shifts local time (Iran UTC+3:30)', () => {
  const dnd = { mode: 'schedule', schedule: { from: '22:00', to: '07:00', days: [0, 1, 2, 3, 4, 5, 6], tzOffsetMin: IR } };
  assert.equal(D.isDndActive(dnd, at('2026-10-19T18:45:00Z')), true);   // ۲۲:۱۵ به وقت تهران
  assert.equal(D.isDndActive(dnd, at('2026-10-19T17:00:00Z')), false);  // ۲۰:۳۰ تهران
  assert.equal(D.isDndActive(dnd, at('2026-10-20T03:00:00Z')), true);   // ۰۶:۳۰ تهران
  assert.equal(D.isDndActive(dnd, at('2026-10-20T03:30:00Z')), false);  // ۰۷:۰۰ تهران
});
test('invalid schedules are inactive instead of throwing', () => {
  for (const s of [{ from: '25:00', to: '07:00', days: [1] }, { from: '08:00', to: '08:00', days: [1] }, { from: '08:00', to: '09:00', days: [] }, { from: '08:00', to: '09:00' }, null]) {
    assert.equal(D.isDndActive({ mode: 'schedule', schedule: s }, at('2026-10-19T08:30:00Z')), false);
  }
});
test('suppressesPush: messages always while active; calls only when allowCalls is off', () => {
  const now = at('2026-10-19T10:00:00Z');
  const base = { mode: 'until', until: now + 1000 };
  assert.equal(D.suppressesPush(base, 'message', now), true);
  assert.equal(D.suppressesPush(base, 'call', now), true);
  assert.equal(D.suppressesPush({ ...base, allowCalls: true }, 'call', now), false);
  assert.equal(D.suppressesPush({ ...base, allowCalls: true }, 'message', now), true);
  assert.equal(D.suppressesPush({ mode: 'off' }, 'message', now), false);
});
test('sanitizeDnd: valid forms normalised, everything else rejected', () => {
  const now = at('2026-10-19T10:00:00Z');
  assert.deepEqual(D.sanitizeDnd({ mode: 'off' }, now), { mode: 'off', allowCalls: false });
  assert.deepEqual(D.sanitizeDnd({ mode: 'until', until: now + 3600_000, allowCalls: true }, now), { mode: 'until', until: now + 3600_000, allowCalls: true });
  assert.equal(D.sanitizeDnd({ mode: 'until', until: now - 1 }, now), null);                       // گذشته
  assert.equal(D.sanitizeDnd({ mode: 'until', until: now + 31 * 24 * 3600_000 }, now), null);      // بیش از ۳۰ روز
  assert.deepEqual(D.sanitizeDnd({ mode: 'schedule', schedule: { from: '22:00', to: '07:00', days: [3, 1, 1], tzOffsetMin: 210 } }, now), { mode: 'schedule', allowCalls: false, schedule: { from: '22:00', to: '07:00', days: [1, 3], tzOffsetMin: 210 } });
  for (const bad of [null, 'x', { mode: 'x' }, { mode: 'off', allowCalls: 'yes' }, { mode: 'schedule' }, { mode: 'schedule', schedule: { from: '22:00', to: '22:00', days: [1] } }, { mode: 'schedule', schedule: { from: '22:00', to: '07:00', days: [9] } }, { mode: 'schedule', schedule: { from: '22:00', to: '07:00', days: [1], tzOffsetMin: 99999 } }, { mode: 'schedule', schedule: { from: '7:00', to: '08:00', days: [1] } }]) assert.equal(D.sanitizeDnd(bad, now), null, JSON.stringify(bad));
});
test('pushPolicy: master switch and DND both gate; calls ignore the master message switch', () => {
  const now = at('2026-10-19T10:00:00Z');
  assert.equal(P.shouldPush({ enabled: true }, 'message', now), true);
  assert.equal(P.shouldPush({ enabled: false }, 'message', now), false);
  assert.equal(P.shouldPush({ enabled: true, dnd: { mode: 'until', until: now + 5 } }, 'message', now), false);
  assert.equal(P.shouldPush({ enabled: false }, 'call', now), true);
  assert.equal(P.shouldPush(undefined, 'message', now), true);
});
