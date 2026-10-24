const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/utils/appSettingsPolicy');

test('language: only the 20 supported codes', () => {
  assert.equal(P.sanitizeLanguage('fa'), 'fa'); assert.equal(P.sanitizeLanguage('uk'), 'uk');
  for (const bad of ['xx', 'EN', '', null, 5, undefined, 'en-US', '../etc']) assert.equal(P.sanitizeLanguage(bad), null);
});
test('lock prefs: valid subset accepted; invalid values reject the whole update; empty = null', () => {
  assert.deepEqual(P.sanitizeLockPrefs({ autoLockMode: 'timer', autoLockMinutes: 5, hideNotificationContent: false }), { autoLockMode: 'timer', autoLockMinutes: 5, hideNotificationContent: false });
  assert.deepEqual(P.sanitizeLockPrefs({ autoLockMode: 'on_exit' }), { autoLockMode: 'on_exit' });
  assert.equal(P.sanitizeLockPrefs({ autoLockMode: 'never' }), null);
  assert.equal(P.sanitizeLockPrefs({ autoLockMinutes: 0 }), null);
  assert.equal(P.sanitizeLockPrefs({ autoLockMinutes: 1441 }), null);
  assert.equal(P.sanitizeLockPrefs({ autoLockMinutes: 1.5 }), null);
  assert.equal(P.sanitizeLockPrefs({ hideNotificationContent: 'yes' }), null);
  assert.equal(P.sanitizeLockPrefs({}), null); assert.equal(P.sanitizeLockPrefs(null), null);
});
test('lock prefs NEVER carry the pin, its hash or the enabled flag', () => {
  const r = P.sanitizeLockPrefs({ autoLockMode: 'timer', enabled: true, pin: '1234', pinHash: 'abc', autoLockMinutes: 3 });
  assert.deepEqual(r, { autoLockMode: 'timer', autoLockMinutes: 3 });
  assert.equal(P.sanitizeLockPrefs({ enabled: true, pin: '1234' }), null);
});
test('translate prefs: url/model/target accepted; apiKey and consentHost are dropped; credentials in URL rejected', () => {
  const r = P.sanitizeTranslatePrefs({ baseUrl: ' https://api.example.com/v1 ', model: ' gpt-x ', target: 'de', apiKey: 'SECRET', consentHost: 'h' });
  assert.deepEqual(r, { baseUrl: 'https://api.example.com/v1', model: 'gpt-x', target: 'de' });
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  assert.equal(P.sanitizeTranslatePrefs({ baseUrl: 'https://user:pass@x.com' }), null);
  assert.equal(P.sanitizeTranslatePrefs({ baseUrl: 'ftp://x.com' }), null);
  assert.equal(P.sanitizeTranslatePrefs({ baseUrl: 'not a url' }), null);
  assert.equal(P.sanitizeTranslatePrefs({ baseUrl: 'https://x.com/' + 'a'.repeat(400) }), null);
  assert.equal(P.sanitizeTranslatePrefs({ target: 'xx' }), null);
  assert.deepEqual(P.sanitizeTranslatePrefs({ target: '' }), { target: '' }); // خالی = «زبان اپ»
  assert.deepEqual(P.sanitizeTranslatePrefs({ baseUrl: '' }), { baseUrl: '' }); // پاک‌کردن مجاز
  assert.equal(P.sanitizeTranslatePrefs({ apiKey: 'only-secret' }), null);
});
test('acceptStamp: newer wins, stale/equal/garbage/far-future rejected', () => {
  const now = 1_700_000_000_000;
  assert.equal(P.acceptStamp(0, now - 10, now), now - 10);
  assert.equal(P.acceptStamp(now - 10, now, now), now);
  assert.equal(P.acceptStamp(now, now - 1, now), null);      // قدیمی‌تر
  assert.equal(P.acceptStamp(now, now, now), null);          // مساوی
  assert.equal(P.acceptStamp(0, NaN, now), null); assert.equal(P.acceptStamp(0, -5, now), null); assert.equal(P.acceptStamp(0, '5', now), null);
  assert.equal(P.acceptStamp(0, now + P.MAX_SKEW_MS + 1, now), null); // ساعت غلط/جعلیِ آینده نمی‌تواند همه‌چیز را قفل کند
  assert.equal(P.acceptStamp(0, now + P.MAX_SKEW_MS, now), now + P.MAX_SKEW_MS);
});
