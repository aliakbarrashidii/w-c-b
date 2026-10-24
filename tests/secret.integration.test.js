// تست یکپارچه‌ی چت مخفی (سوکت واقعی + دیتابیس واقعی): تایمر از «خواندنِ گیرنده» شروع می‌شود (حتی با رسید خاموش)،
// فقط یک‌بار، پخش message:expires، پیام سرویس تغییر تایمر + رویداد secret:ttl، اعلان اسکرین‌شات با محدودیت نرخ.
// اجرا:  TEST_MONGO_URI=mongodb://127.0.0.1:27017 node --test --test-force-exit tests/secret.integration.test.js
process.env.JWT_SECRET = 'test-secret';
process.env.MESSAGE_ENCRYPTION_KEY = 'b'.repeat(64);

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');

const SKIP = process.env.TEST_MONGO_URI ? false : 'TEST_MONGO_URI تنظیم نشده';
const User = require('../src/models/User');
const Chat = require('../src/models/Chat');
const Message = require('../src/models/Message');

let srv; let port; let A; let B; let X; let chat; let cA; let cB; let base;
const evA = []; const evB = [];
const tok = (u) => jwt.sign({ id: String(u._id), role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const open = (u) => new Promise((resolve, reject) => {
  const c = connect(`http://127.0.0.1:${port}`, { auth: { token: tok(u) }, transports: ['websocket'], reconnection: false });
  c.on('connect', () => resolve(c)); c.on('connect_error', reject);
});
const ask = (client, ev, payload) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`ack نیامد: ${ev}`)), 5000);
  client.emit(ev, payload, (res) => { clearTimeout(t); resolve(res); });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const setTtl = (u, sec) => fetch(`${base}/api/chats/${chat._id}/secret-ttl`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok(u)}` }, body: JSON.stringify({ ttlSeconds: sec }) });
let n = 0;
const sendFromA = async (content = 'x') => (await ask(cA, 'message:send', { chatId: String(chat._id), type: 'text', content, clientId: `s${Date.now()}_${n++}` })).message;

test.before(async () => {
  if (SKIP) return;
  await mongoose.connect(process.env.TEST_MONGO_URI, { dbName: `wizsecret_${Date.now()}` });
  await Promise.all([User, Chat, Message].map((M) => M.init().catch(() => {})));
  A = await User.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x' });
  B = await User.create({ username: 'bob', displayName: 'Bob', passwordHash: 'x' });
  X = await User.create({ username: 'xavier', displayName: 'Xavier', passwordHash: 'x' });
  chat = await Chat.create({ type: 'secret', members: [{ user: A._id }, { user: B._id }], secretSettings: { ttlSeconds: 0 } });
  const app = express(); app.use(express.json());
  srv = http.createServer(app);
  const io = new Server(srv, { cors: { origin: '*' } });
  app.set('io', io);
  app.use('/api/chats', require('../src/routes/chats'));
  require('../src/socket')(io);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port; base = `http://127.0.0.1:${port}`;
  cA = await open(A); cB = await open(B);
  for (const [c, arr] of [[cA, evA], [cB, evB]]) for (const e of ['secret:ttl', 'message:expires', 'message:new']) c.on(e, (p) => arr.push({ e, p }));
});
test.after(async () => {
  if (SKIP) return;
  cA?.close(); cB?.close(); srv?.close();
  await new Promise((r) => setTimeout(r, 1500));
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
});

test('تغییر تایمر: ذخیره + secret:ttl برای هر دو + پیام سرویس؛ همان مقدار دوباره = بی‌صدا', { skip: SKIP }, async () => {
  const r = await setTtl(A, 60);
  assert.equal(r.status, 200);
  await wait(400);
  assert.equal((await Chat.findById(chat._id)).secretSettings.ttlSeconds, 60);
  for (const arr of [evA, evB]) {
    const t = arr.find((x) => x.e === 'secret:ttl');
    assert.ok(t, 'secret:ttl نرسید'); assert.equal(t.p.ttlSeconds, 60); assert.equal(t.p.by, String(A._id));
    const svc = arr.find((x) => x.e === 'message:new' && x.p.type === 'system_action');
    assert.ok(svc, 'پیام سرویس نرسید');
    assert.deepEqual({ a: svc.p.mediaMeta.action, t: svc.p.mediaMeta.ttlSeconds }, { a: 'secret_ttl', t: 60 });
    assert.equal(String(svc.p.sender._id), String(A._id));
  }
  const before = await Message.countDocuments({ chat: chat._id, type: 'system_action' });
  await setTtl(A, 60); await wait(300);
  assert.equal(await Message.countDocuments({ chat: chat._id, type: 'system_action' }), before); // تغییری نبود
});

test('مقدار نامعتبر و غیرعضو رد می‌شوند', { skip: SKIP }, async () => {
  assert.equal((await setTtl(A, -5)).status, 400);
  assert.equal((await setTtl(A, 31 * 86400)).status, 400);
  assert.equal((await setTtl(A, 'abc')).status, 400);
  assert.equal((await setTtl(X, 5)).status, 403);
  assert.equal((await Chat.findById(chat._id)).secretSettings.ttlSeconds, 60);
});

test('تایمر با «خواندنِ گیرنده» شروع می‌شود، فرستنده‌ی خواننده بی‌اثر، پخش message:expires', { skip: SKIP }, async () => {
  const m = await sendFromA('راز');
  const id = String(m._id);
  evA.length = 0; evB.length = 0;
  cA.emit('message:read', { chatId: String(chat._id), messageId: id }); // فرستنده خودش «خواند»
  await wait(300);
  assert.equal((await Message.findById(id)).expiresAt, null);
  cB.emit('message:read', { chatId: String(chat._id), messageId: id });
  await wait(400);
  const exp = (await Message.findById(id)).expiresAt;
  assert.ok(exp, 'expiresAt ست نشد');
  assert.ok(Math.abs(exp.getTime() - (Date.now() + 60_000)) < 5000);
  for (const arr of [evA, evB]) { const e = arr.find((x) => x.e === 'message:expires'); assert.ok(e); assert.equal(e.p.messageId, id); }
  // خواندنِ دوباره حذف را عقب نمی‌اندازد
  await wait(1200);
  cB.emit('message:read', { chatId: String(chat._id), messageId: id });
  await wait(300);
  assert.equal((await Message.findById(id)).expiresAt.getTime(), exp.getTime());
});

test('گیرنده‌ای که رسید خوانده‌شدن را خاموش کرده هم تایمر را شروع می‌کند (باگ قبلی)', { skip: SKIP }, async () => {
  await User.updateOne({ _id: B._id }, { $set: { 'privacy.readReceiptsEnabled': false } });
  const m = await sendFromA('بدون رسید');
  cB.emit('message:read', { chatId: String(chat._id), messageId: String(m._id) });
  await wait(400);
  const doc = await Message.findById(m._id);
  assert.ok(doc.expiresAt, 'تایمر شروع نشد');
  assert.equal((doc.readBy || []).length, 0);               // رسید ثبت/پخش نشد (حریم خصوصی حفظ شد)
});

test('پیام سرویس هرگز خودتخریب نمی‌شود', { skip: SKIP }, async () => {
  const svc = await Message.findOne({ chat: chat._id, type: 'system_action' });
  cB.emit('message:read', { chatId: String(chat._id), messageId: String(svc._id) });
  await wait(300);
  assert.equal((await Message.findById(svc._id)).expiresAt, null);
});

test('تایمر خاموش: پیام هرگز expiresAt نمی‌گیرد', { skip: SKIP }, async () => {
  await setTtl(B, 0); await wait(300);
  const m = await sendFromA('ماندگار');
  cB.emit('message:read', { chatId: String(chat._id), messageId: String(m._id) });
  await wait(300);
  assert.equal((await Message.findById(m._id)).expiresAt, null);
});

test('اسکرین‌شات: پیام سرویس برای هر دو؛ محدودیت نرخ؛ غیرعضو و چت غیرمخفی رد', { skip: SKIP }, async () => {
  evA.length = 0; evB.length = 0;
  const r1 = await ask(cB, 'secret:screenshot', { chatId: String(chat._id) });
  assert.ok(r1.ok && !r1.throttled);
  await wait(300);
  for (const arr of [evA, evB]) {
    const svc = arr.find((x) => x.e === 'message:new' && x.p.mediaMeta?.action === 'secret_screenshot');
    assert.ok(svc); assert.equal(String(svc.p.sender._id), String(B._id));
  }
  const count = await Message.countDocuments({ chat: chat._id, 'mediaMeta.action': 'secret_screenshot' });
  const r2 = await ask(cB, 'secret:screenshot', { chatId: String(chat._id) });
  assert.ok(r2.ok && r2.throttled);
  assert.equal(await Message.countDocuments({ chat: chat._id, 'mediaMeta.action': 'secret_screenshot' }), count);
  const cX = await open(X);
  assert.ok((await ask(cX, 'secret:screenshot', { chatId: String(chat._id) })).error);
  cX.close();
  const priv = await Chat.create({ type: 'private', members: [{ user: A._id }, { user: B._id }] });
  assert.ok((await ask(cB, 'secret:screenshot', { chatId: String(priv._id) })).error);
  assert.ok((await ask(cB, 'secret:screenshot', {})).error);
});

test('ack پیام، clientId را برمی‌گرداند (کلیدِ پایدارِ لیست در اپ برای جلوگیری از انیمیشنِ دوباره به آن وابسته است)', { skip: SKIP }, async () => {
  const cid = `k${Date.now()}`;
  const res = await ask(cA, 'message:send', { chatId: String(chat._id), type: 'text', content: 'x', clientId: cid });
  assert.ok(res.ok);
  assert.equal(res.message.clientId, cid);
  assert.notEqual(String(res.message._id), cid);          // _id سرور با clientId فرق دارد؛ همین فرق باعث بازسازیِ کامپوننت می‌شد
});
