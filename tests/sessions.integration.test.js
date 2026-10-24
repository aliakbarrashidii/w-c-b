// تست یکپارچه‌ی سیاست نشست‌ها (روتر واقعی auth + میدل‌ویر واقعی + دیتابیس واقعی).
// اجرا:  TEST_MONGO_URI=mongodb://127.0.0.1:27017 node --test --test-force-exit tests/sessions.integration.test.js
process.env.JWT_SECRET = 'test-secret';
process.env.MESSAGE_ENCRYPTION_KEY = 'b'.repeat(64);

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const SKIP = process.env.TEST_MONGO_URI ? false : 'TEST_MONGO_URI تنظیم نشده';
const User = require('../src/models/User');
const Session = require('../src/models/Session');

let srv; let base;
const dev = (id, name = `Phone ${id}`) => ({ id, name, platform: 'android', osVersion: 'Android 14', appVersion: '1.0.0' });
async function call(method, path, { token, body } = {}) {
  const r = await fetch(`${base}/api/auth${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
const login = (username, device, extra = {}) => call('POST', '/login', { body: { username, password: 'secret123', ...(device ? { device } : {}), ...extra } });

test.before(async () => {
  if (SKIP) return;
  await mongoose.connect(process.env.TEST_MONGO_URI, { dbName: `wizsess_${Date.now()}` });
  await Promise.all([User, Session].map((M) => M.init().catch(() => {})));
  const passwordHash = await bcrypt.hash('secret123', 4);
  await User.create({ username: 'alice', displayName: 'Alice', passwordHash });
  await User.create({ username: 'bob', displayName: 'Bob', passwordHash });
  const app = express();
  app.use(express.json());
  app.set('io', null);
  app.use('/api/auth', require('../src/routes/auth'));
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(async () => {
  if (SKIP) return;
  srv?.close();
  await new Promise((r) => setTimeout(r, 500));
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
});

let t1; let t2; let s2id;

test('اولین ورودِ حساب: نام دستگاه ذخیره می‌شود و محدود نیست', { skip: SKIP }, async () => {
  const r = await login('alice', dev('dev-1', 'Pixel 7'));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  t1 = r.json.token;
  const list = await call('GET', '/sessions', { token: t1 });
  assert.equal(list.json.length, 1);
  assert.equal(list.json[0].deviceName, 'Pixel 7');   // قبلاً همه «دستگاه ناشناس» بودند
  assert.equal(list.json[0].restricted, false);
  assert.equal(list.json[0].isCurrent, true);
});

test('دستگاه ناشناسِ تازه: محدود است و نمی‌تواند نشست‌ها را ببندد / رمز را عوض کند / حساب را حذف کند', { skip: SKIP }, async () => {
  const r = await login('alice', dev('dev-2', 'Galaxy S24'));
  assert.equal(r.status, 200);
  t2 = r.json.token;
  const list = await call('GET', '/sessions', { token: t2 });
  const mine = list.json.find((s) => s.isCurrent);
  s2id = mine._id;
  assert.equal(mine.restricted, true);
  assert.ok(new Date(mine.restrictedUntil) - Date.now() > 23 * 3600 * 1000);
  const first = list.json.find((s) => !s.isCurrent);

  let x = await call('DELETE', `/sessions/${first._id}`, { token: t2 });
  assert.equal(x.status, 403); assert.equal(x.json.code, 'SESSION_RESTRICTED');
  x = await call('POST', '/sessions/revoke-all-others', { token: t2 });
  assert.equal(x.status, 403); assert.equal(x.json.code, 'SESSION_RESTRICTED');
  x = await call('POST', '/change-password', { token: t2, body: { currentPassword: 'secret123', newPassword: 'newsecret1' } });
  assert.equal(x.status, 403); assert.equal(x.json.code, 'SESSION_RESTRICTED');
  x = await call('DELETE', '/me', { token: t2, body: { password: 'secret123' } });
  assert.equal(x.status, 403); assert.equal(x.json.code, 'SESSION_RESTRICTED');
  // همه‌ی نشست‌های قدیمی هنوز سالم‌اند
  assert.equal((await Session.countDocuments({ revoked: false })), 2);
});

test('دستگاه تازه نمی‌تواند خودش را تأیید کند؛ دستگاه قدیمی می‌تواند', { skip: SKIP }, async () => {
  let x = await call('POST', `/sessions/${s2id}/confirm`, { token: t2 });
  assert.equal(x.status, 403); assert.equal(x.json.code, 'CANNOT_CONFIRM');
  x = await call('POST', `/sessions/${s2id}/confirm`, { token: t1 });
  assert.equal(x.status, 200, JSON.stringify(x.json));
  const list = await call('GET', '/sessions', { token: t2 });
  assert.equal(list.json.find((s) => s.isCurrent).restricted, false);
});

test('ورود مجدد از دستگاهِ معتبرشده محدود نمی‌شود (هشدار الکی نمی‌دهد)', { skip: SKIP }, async () => {
  const r = await login('alice', dev('dev-2', 'Galaxy S24'));
  const list = await call('GET', '/sessions', { token: r.json.token });
  assert.equal(list.json.find((s) => s.isCurrent).restricted, false);
});

test('کلاینت قدیمی (بدون اطلاعات دستگاه) روی حساب دارای نشست: محتاطانه محدود', { skip: SKIP }, async () => {
  const r = await login('alice', null);
  assert.equal(r.status, 200);
  const list = await call('GET', '/sessions', { token: r.json.token });
  assert.equal(list.json.find((s) => s.isCurrent).restricted, true);
});

test('«نه، من نبودم»: دستگاه معتبر نشست مشکوک را می‌بندد و توکنش بی‌اثر می‌شود', { skip: SKIP }, async () => {
  const attacker = await login('alice', dev('dev-evil', 'Unknown Box'));
  const mine = (await call('GET', '/sessions', { token: attacker.json.token })).json.find((s) => s.isCurrent);
  const x = await call('DELETE', `/sessions/${mine._id}`, { token: t1 });
  assert.equal(x.status, 200);
  const after = await call('GET', '/sessions', { token: attacker.json.token });
  assert.equal(after.status, 401);
});

test('خروج از خودِ همان دستگاهِ محدود همیشه آزاد است', { skip: SKIP }, async () => {
  const r = await login('alice', dev('dev-3', 'Tablet'));
  const mine = (await call('GET', '/sessions', { token: r.json.token })).json.find((s) => s.isCurrent);
  assert.equal(mine.restricted, true);
  const x = await call('DELETE', `/sessions/${mine._id}`, { token: r.json.token });
  assert.equal(x.status, 200);
});

test('حساب دیگر: اولین ورودش محدود نیست (محدودیت مخصوص هر حساب است)', { skip: SKIP }, async () => {
  const r = await login('bob', dev('dev-2', 'Galaxy S24'));
  const list = await call('GET', '/sessions', { token: r.json.token });
  assert.equal(list.json[0].restricted, false);
});

test('دستگاهِ معتبر می‌تواند همه‌ی نشست‌های دیگر را ببندد', { skip: SKIP }, async () => {
  const x = await call('POST', '/sessions/revoke-all-others', { token: t1 });
  assert.equal(x.status, 200);
  assert.equal(await Session.countDocuments({ user: (await User.findOne({ username: 'alice' }))._id, revoked: false }), 1);
});

test('پوشِ هشدار ورود جدید: فقط برای دستگاه ناشناسِ تازه، با توکن‌های قبلی و لینک به چتِ سیستمی', { skip: SKIP }, async () => {
  const push = require('../src/utils/push');
  const calls = [];
  const orig = push.sendPushNotifications;
  push.sendPushNotifications = async (tokens, payload) => { calls.push({ tokens, payload }); };
  try {
    const carol = await User.create({ username: 'carol', displayName: 'Carol', passwordHash: await bcrypt.hash('secret123', 4), pushTokens: ['ExponentPushToken[old-phone]'] });
    assert.equal((await login('carol', dev('c-1', 'Old Phone'))).status, 200);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(calls.length, 0, 'اولین ورودِ حساب نباید هشدار بدهد');

    assert.equal((await login('carol', dev('c-2', 'Unknown Tablet'))).status, 200);   // دستگاه ناشناسِ تازه
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(calls.length, 1, 'باید یک پوش برود');
    assert.deepEqual(calls[0].tokens, ['ExponentPushToken[old-phone]']);
    const d = calls[0].payload.data;
    assert.equal(d.type, 'message'); assert.equal(d.kind, 'new_login'); assert.equal(d.recipientId, String(carol._id));
    assert.ok(calls[0].payload.body.startsWith('Unknown Tablet'));
    const Message = require('../src/models/Message');
    const msg = await Message.findById(d.messageId);
    assert.ok(msg, 'messageId باید به پیامِ هشدار اشاره کند');
    assert.equal(String(msg.chat), d.chatId); assert.equal(msg.mediaMeta.action, 'confirm_login');

    assert.equal((await login('carol', dev('c-2', 'Unknown Tablet'))).status, 200);   // همان دستگاه دوباره (هنوز محدود/شناخته)
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(calls.length, 1, 'ورود مجدد از همان دستگاه هشدار الکی نمی‌دهد');

    // «نه، من نبودم» → نشست باطل می‌شود؛ ورودِ دوباره‌ی همان دستگاه باید دوباره هشدار بدهد
    const Sess = require('../src/models/Session');
    await Sess.updateMany({ user: carol._id, deviceId: 'c-2' }, { revoked: true });
    assert.equal((await login('carol', dev('c-2', 'Unknown Tablet'))).status, 200);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(calls.length, 2, 'بعد از باطل‌شدنِ نشست، ورودِ دوباره دوباره هشدار می‌دهد');

    // کاربر بدون توکن پوش: بی‌صدا بدون خطا
    await User.updateOne({ _id: carol._id }, { pushTokens: [] });
    assert.equal((await login('carol', dev('c-3', 'Third'))).status, 200);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(calls.length, 2);
  } finally { push.sendPushNotifications = orig; }
});
