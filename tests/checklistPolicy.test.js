const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/utils/checklistPolicy');

test('parseIndex: فقط عدد صحیح در بازه', () => {
  assert.equal(C.parseIndex(0), 0);
  assert.equal(C.parseIndex('7'), 7);
  assert.equal(C.parseIndex(29), 29);
  for (const bad of [-1, 30, 1.5, 'x', '', null, undefined, {}, [], NaN, '-1', '1e1']) assert.equal(C.parseIndex(bad), null);
});
test('toggle: تیک، برداشتن، تکراری و نامعتبر', () => {
  let d = C.toggle([], 'u1', 2, true);
  assert.deepEqual(d, [{ index: 2, by: 'u1' }]);
  d = C.toggle(d, 'u2', 0, true);
  assert.deepEqual(d.map((x) => x.index), [0, 2]);            // مرتب
  d = C.toggle(d, 'u2', 2, true);                              // تیک‌زدنِ دوباره = بدون تکرار
  assert.equal(d.filter((x) => x.index === 2).length, 1);
  assert.equal(d.find((x) => x.index === 2).by, 'u2');         // آخرین نوشتن
  d = C.toggle(d, 'u1', 0, false);
  assert.deepEqual(d.map((x) => x.index), [2]);
  assert.deepEqual(C.toggle(d, 'u1', 5, false), d);            // برداشتنِ تیک‌نخورده بی‌اثر
  assert.equal(C.toggle(d, 'u1', 99, true), null);
  assert.deepEqual(C.toggle(undefined, 'u1', 1, true), [{ index: 1, by: 'u1' }]);
});
test('shapeDone: by به رشته', () => {
  assert.deepEqual(C.shapeDone([{ index: 1, by: { toString: () => 'abc' } }]), [{ index: 1, by: 'abc' }]);
  assert.deepEqual(C.shapeDone(undefined), []);
});
