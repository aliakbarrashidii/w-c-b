const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/utils/sessionPolicy');
const NOW = 1_700_000_000_000;
const H = 3600 * 1000;

test('first session of an account is never restricted', () => {
  assert.equal(P.computeRestrictedUntil({ hadPriorSession: false, knownDevice: false, now: NOW }), null);
});
test('new unknown device on an existing account is restricted for 24h', () => {
  const t = P.computeRestrictedUntil({ hadPriorSession: true, knownDevice: false, now: NOW });
  assert.equal(t.getTime(), NOW + 24 * H);
});
test('re-login from an already-trusted device is not restricted', () => {
  assert.equal(P.computeRestrictedUntil({ hadPriorSession: true, knownDevice: true, now: NOW }), null);
});
test('isRestricted: active window, expired window, confirmed, legacy sessions', () => {
  assert.equal(P.isRestricted({ restrictedUntil: new Date(NOW + H) }, NOW), true);
  assert.equal(P.isRestricted({ restrictedUntil: new Date(NOW - H) }, NOW), false);
  assert.equal(P.isRestricted({ restrictedUntil: new Date(NOW + H), confirmedAt: new Date(NOW) }, NOW), false);
  assert.equal(P.isRestricted({}, NOW), false); // نشست‌های قدیمی بدون فیلد = معتبر
  assert.equal(P.isRestricted(null, NOW), false);
});
test('canConfirm: only a trusted, different session can confirm a restricted one', () => {
  const trusted = { _id: 'a' };
  const fresh = { _id: 'b', restrictedUntil: new Date(NOW + H) };
  const fresh2 = { _id: 'c', restrictedUntil: new Date(NOW + H) };
  assert.equal(P.canConfirm(trusted, fresh, NOW), true);
  assert.equal(P.canConfirm(fresh, fresh, NOW), false);   // خودتأییدی ممنوع (مهاجم نمی‌تواند خودش را تأیید کند)
  assert.equal(P.canConfirm(fresh2, fresh, NOW), false);  // نشست محدود دیگر هم نمی‌تواند
  assert.equal(P.canConfirm({ _id: 'a', revoked: true }, fresh, NOW), false);
  assert.equal(P.canConfirm(trusted, { _id: 'd' }, NOW), false); // هدف اصلاً محدود نیست
  assert.equal(P.canConfirm(null, fresh, NOW), false);
});
test('sanitizeDeviceInfo: trims, clips, whitelists platform, supports legacy deviceName', () => {
  const r = P.sanitizeDeviceInfo({ device: { id: ' abc ', name: 'x'.repeat(200), platform: 'android', osVersion: '14', appVersion: '1.0.0' } });
  assert.equal(r.deviceId, 'abc'); assert.equal(r.deviceName.length, 80); assert.equal(r.platform, 'android');
  assert.equal(P.sanitizeDeviceInfo({ device: { platform: 'symbian' } }).platform, '');
  assert.equal(P.sanitizeDeviceInfo({ deviceName: 'Old phone' }).deviceName, 'Old phone');
  assert.equal(P.sanitizeDeviceInfo({}).deviceId, '');
  assert.equal(P.sanitizeDeviceInfo({ device: { id: 123 } }).deviceId, '');
});
