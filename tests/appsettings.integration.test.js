// تست یکپارچه‌ی همگام‌سازی تنظیمات (روتر واقعی + دیتابیس واقعی): زبان/ترجمه/قفل با مهر زمانی؛ رازها هرگز ذخیره نمی‌شوند.
// اجرا:  TEST_MONGO_URI=mongodb://127.0.0.1:27017 node --test --test-force-exit tests/appsettings.integration.test.js
process.env.JWT_SECRET = 'test-secret';
process.env.MESSAGE_ENCRYPTION_KEY = 'b'.repeat(64);
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const SKIP = process.env.TEST_MONGO_URI ? false : 'TEST_MONGO_URI تنظیم نشده';
let srv; let base; let token; let User;
async function call(method, path, body, tk = token) {
  const r = await fetch(`${base}/api/auth${path}`, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
const patch = (b) => call('PATCH', '/me/app-settings', b);
const NOW = () => Date.now();

test.before(async () => {
  if (SKIP) return;
  await mongoose.connect(process.env.TEST_MONGO_URI, { dbName: `wizset_${Date.now()}` });
  User = require('../src/models/User');
  await Promise.all([User, require('../src/models/Session')].map((M) => M.init().catch(() => {})));
  await User.create({ username: 'carol', displayName: 'Carol', passwordHash: await bcrypt.hash('secret123', 4) });
  const app = express(); app.use(express.json()); app.set('io', null);
  app.use('/api/auth', require('../src/routes/auth'));
  srv = http.createServer(app); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  token = (await call('POST', '/login', { username: 'carol', password: 'secret123', device: { id: 'd1', name: 'Phone' } }, null)).json.token;
});
test.after(async () => { if (SKIP) return; srv?.close(); await new Promise((r) => setTimeout(r, 400)); await mongoose.connection.dropDatabase().catch(() => {}); await mongoose.disconnect(); });

test('language: saved with its stamp and returned on the next /me', { skip: SKIP }, async () => {
  const at = NOW();
  const r = await patch({ language: 'de', languageAt: at });
  assert.equal(r.status, 200); assert.deepEqual(r.json.ignored, []);
  const me = await call('GET', '/me');
  assert.equal(me.json.appSettings.language, 'de'); assert.equal(me.json.appSettings.languageAt, at);
});

test('a STALE write (older stamp) from another device is ignored and reported', { skip: SKIP }, async () => {
  const r = await patch({ language: 'fr', languageAt: NOW() - 60_000 });
  assert.equal(r.status, 200); assert.deepEqual(r.json.ignored, ['language']);
  assert.equal((await call('GET', '/me')).json.appSettings.language, 'de'); // تغییری نکرد
});

test('a newer write wins; far-future stamps and invalid values are rejected', { skip: SKIP }, async () => {
  assert.deepEqual((await patch({ language: 'ja', languageAt: NOW() + 1 })).json.ignored, []);
  assert.equal((await call('GET', '/me')).json.appSettings.language, 'ja');
  assert.deepEqual((await patch({ language: 'ko', languageAt: NOW() + 3600_000 })).json.ignored, ['language']); // آینده‌ی دور
  assert.equal((await patch({ language: 'klingon', languageAt: NOW() + 5 })).status, 400);
  assert.equal((await call('GET', '/me')).json.appSettings.language, 'ja');
});

test('lock prefs sync; PIN, enabled flag are never stored', { skip: SKIP }, async () => {
  const r = await patch({ lockPrefs: { autoLockMode: 'timer', autoLockMinutes: 7, hideNotificationContent: false, enabled: true, pin: '1234' }, lockPrefsAt: NOW() });
  assert.equal(r.status, 200);
  const doc = await User.findOne({ username: 'carol' }).lean();
  assert.deepEqual({ ...doc.appSettings.lockPrefs }, { autoLockMode: 'timer', autoLockMinutes: 7, hideNotificationContent: false });
  assert.ok(!JSON.stringify(doc).includes('1234'));
  assert.equal((await patch({ lockPrefs: { autoLockMinutes: 99999 }, lockPrefsAt: NOW() + 10 })).status, 400);
});

test('translation prefs sync; the API key is never stored anywhere on the server', { skip: SKIP }, async () => {
  const r = await patch({ translate: { baseUrl: 'https://api.example.com/v1', model: 'm1', target: 'es', apiKey: 'sk-SUPERSECRET' }, translateAt: NOW() });
  assert.equal(r.status, 200);
  const doc = await User.findOne({ username: 'carol' }).lean();
  assert.deepEqual({ ...doc.appSettings.translate }, { baseUrl: 'https://api.example.com/v1', model: 'm1', target: 'es' });
  assert.ok(!JSON.stringify(doc).includes('SUPERSECRET'));
  assert.equal((await patch({ translate: { baseUrl: 'https://u:p@evil.com' }, translateAt: NOW() + 20 })).status, 400);
});

test('partial group update merges instead of wiping the other fields', { skip: SKIP }, async () => {
  await patch({ lockPrefs: { hideNotificationContent: true }, lockPrefsAt: NOW() + 30 });
  const doc = await User.findOne({ username: 'carol' }).lean();
  assert.equal(doc.appSettings.lockPrefs.autoLockMode, 'timer'); assert.equal(doc.appSettings.lockPrefs.hideNotificationContent, true);
});

test('existing keys (theme, link previews) still work in the same request', { skip: SKIP }, async () => {
  const r = await patch({ themeId: 'dark', linkPreviews: false, language: 'it', languageAt: NOW() + 40 });
  assert.equal(r.status, 200);
  const s = (await call('GET', '/me')).json.appSettings;
  assert.equal(s.themeId, 'dark'); assert.equal(s.linkPreviews, false); assert.equal(s.language, 'it');
});
