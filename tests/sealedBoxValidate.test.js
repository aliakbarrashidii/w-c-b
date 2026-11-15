const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSealedBox, sealedFor } = require('../src/utils/sealedBoxValidate');
const b = (s) => Buffer.from(s.padEnd(24, 'x')).toString('base64');
const pay = { nonce: b('pn'), ciphertext: b('pc') };
const k = (level, extra = {}) => ({ level, version: 1, ephemeralPublicKey: b('e'), nonce: b('n'), ciphertext: b('c'), ...extra });

test('v1: فقط وقتی هر سه فیلد base64 معتبر باشند', () => {
  assert.ok(validateSealedBox({ ephemeralPublicKey: b('e'), nonce: b('n'), ciphertext: b('c') }).value);
  for (const bad of [null, {}, { ephemeralPublicKey: b('e'), nonce: b('n') }, { ephemeralPublicKey: '!!', nonce: b('n'), ciphertext: b('c') }]) assert.ok(validateSealedBox(bad).error);
});
test('v2: ردیفِ ۰ الزامی، بدونِ تکرار، حداکثر ۱۰ کلید، سطحِ معتبر', () => {
  assert.ok(validateSealedBox({ v: 2, ...pay, keys: [k(0), k(2)] }).value);
  assert.ok(validateSealedBox({ v: 2, ...pay, keys: [k(1), k(2)] }).error);
  assert.ok(validateSealedBox({ v: 2, ...pay, keys: [k(0), k(0)] }).error);
  assert.ok(validateSealedBox({ v: 2, ...pay, keys: Array.from({ length: 11 }, (_, i) => k(i % 10)) }).error);
  assert.ok(validateSealedBox({ v: 2, ...pay, keys: [k(0), k(10)] }).error);
  assert.ok(validateSealedBox({ v: 2, ...pay, keys: [k(0), k(1.5)] }).error);
  assert.ok(validateSealedBox({ v: 2, ...pay, keys: [] }).error);
  assert.ok(validateSealedBox({ v: 9 }).error);
});
test('v2: فیلدهای اضافه دور ریخته می‌شوند و نسخه‌ی نامعتبر ۱ می‌شود', () => {
  const r = validateSealedBox({ v: 2, ...pay, keys: [k(0, { evil: 'x', version: -4 })], extra: 1 });
  assert.deepEqual(Object.keys(r.value.keys[0]).sort(), ['ciphertext', 'ephemeralPublicKey', 'level', 'nonce', 'version']);
  assert.equal(r.value.keys[0].version, 1);
});
test('v2: محتوای رمزشده‌ی سطحِ بالا الزامی است و ذخیره می‌شود', () => {
  assert.ok(validateSealedBox({ v: 2, keys: [k(0)] }).error);
  assert.ok(validateSealedBox({ v: 2, nonce: pay.nonce, keys: [k(0)] }).error);
  const r = validateSealedBox({ v: 2, ...pay, keys: [k(0)] });
  assert.equal(r.value.nonce, pay.nonce); assert.equal(r.value.ciphertext, pay.ciphertext);
  assert.equal(sealedFor({ v: 2, ...pay, keys: [k(0)] }, 0).ciphertext, pay.ciphertext);
});
test('sealedFor: v1 فقط ردیفِ ۰؛ v2 فقط ورودیِ ردیفِ خودش', () => {
  const v1 = { v: 1, ephemeralPublicKey: 'a', nonce: 'b', ciphertext: 'c' };
  assert.ok(sealedFor(v1, 0)); assert.equal(sealedFor(v1, 2), null);
  const v2 = { v: 2, ...pay, keys: [k(0), k(2), k(3)] };
  assert.deepEqual(sealedFor(v2, 2).keys.map((x) => x.level), [2]);
  assert.equal(sealedFor(v2, 1), null);
  assert.equal(sealedFor(null, 0), null);
  assert.equal(sealedFor({ v: 1 }, 0), null); // v1 خالی
});
