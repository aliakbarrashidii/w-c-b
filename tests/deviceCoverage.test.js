const test = require('node:test');
const assert = require('node:assert/strict');
const { checkDeviceCoverage } = require('../src/utils/deviceCoverage');
const devs = [{ user: 'a', deviceId: 'a1' }, { user: 'a', deviceId: 'a2' }, { user: 'b', deviceId: 'b1' }];
const P = (...ids) => ids.map((deviceId) => ({ deviceId }));
test('همه‌ی دستگاه‌ها (جز دستگاهِ فرستنده) پوشش داده شده ⇒ ok', () => {
  assert.equal(checkDeviceCoverage(devs, P('a2', 'b1'), 'a1').ok, true);
  assert.equal(checkDeviceCoverage(devs, P('a1', 'a2', 'b1', 'zombie'), 'a1').ok, true); // دستگاهِ اضافه/حذف‌شده مشکلی نیست
});
test('دستگاهِ جاافتاده (مثلاً دستگاهِ تازه‌ی مخاطب) ⇒ ناقص + فهرستِ درست', () => {
  const r = checkDeviceCoverage(devs, P('a2'), 'a1');
  assert.equal(r.ok, false); assert.deepEqual(r.missing, ['b1']);
  assert.deepEqual(r.devices, { a: ['a1', 'a2'], b: ['b1'] });
});
test('payload خراب/خالی ⇒ ناقص؛ دستگاهِ فرستنده نیازی به payload ندارد', () => {
  assert.equal(checkDeviceCoverage(devs, [], 'a1').ok, false);
  assert.equal(checkDeviceCoverage(devs, null, 'a1').ok, false);
  assert.equal(checkDeviceCoverage([{ user: 'a', deviceId: 'a1' }], [], 'a1').ok, true);
  assert.equal(checkDeviceCoverage(devs, [null, {}, { deviceId: 'b1' }, { deviceId: 'a2' }], 'a1').ok, true);
});
