// تست یکپارچه‌ی فوروارد (هندلر واقعی سوکت + دیتابیس واقعی): «فوروارد از …»، پنهان‌کردن نام فرستنده، کانال، پیام E2E، دسترسی.
process.env.JWT_SECRET = 'test-secret';
process.env.MESSAGE_ENCRYPTION_KEY = 'b'.repeat(64);
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');

const SKIP = process.env.TEST_MONGO_URI ? false : 'TEST_MONGO_URI تنظیم نشده';
const User = require('../src/models/User');
const Chat = require('../src/models/Chat');
const Message = require('../src/models/Message');

let srv; let port; let A; let B; let C; let src; let dst; let chan; let foreign; let clientA; let clientB;
const gotB = [];
const tok = (u) => jwt.sign({ id: String(u._id), role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const open = (u) => new Promise((res, rej) => { const c = connect(`http://127.0.0.1:${port}`, { auth: { token: tok(u) }, transports: ['websocket'], reconnection: false }); c.on('connect', () => res(c)); c.on('connect_error', rej); });
const ask = (client, ev, payload, ms = 5000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`ack نیامد: ${ev}`)), ms); client.emit(ev, payload, (r) => { clearTimeout(t); res(r); }); });
const fwd = (messageId, toChatIds, extra = {}) => ask(clientA, 'message:forward', { messageId: String(messageId), toChatIds: toChatIds.map(String), ...extra });
let n = 0; const cid = () => `f${Date.now()}_${n++}`;
const post = async (client, chatId, content, extra = {}) => (await ask(client, 'message:send', { chatId: String(chatId), type: 'text', content, clientId: cid(), ...extra })).message;

test.before(async () => {
  if (SKIP) return;
  await mongoose.connect(process.env.TEST_MONGO_URI, { dbName: `wizfwd_${Date.now()}` });
  await Promise.all([User, Chat, Message].map((M) => M.init().catch(() => {})));
  A = await User.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x' });
  B = await User.create({ username: 'bob', displayName: 'Bob', passwordHash: 'x' });
  C = await User.create({ username: 'carol', displayName: 'Carol', passwordHash: 'x' });
  src = await Chat.create({ type: 'group', title: 'Source', members: [{ user: A._id, role: 'owner' }, { user: C._id }] });
  dst = await Chat.create({ type: 'private', members: [{ user: A._id }, { user: B._id }] });
  chan = await Chat.create({ type: 'channel', title: 'News', signMessages: false, members: [{ user: A._id, role: 'owner' }, { user: B._id }] });
  foreign = await Chat.create({ type: 'group', title: 'Private to C', members: [{ user: C._id, role: 'owner' }] });
  srv = http.createServer(); const io = new Server(srv, { cors: { origin: '*' } }); require('../src/socket')(io);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); port = srv.address().port;
  clientA = await open(A); clientB = await open(B);
  clientB.on('message:new', (m) => gotB.push(m));
});
test.after(async () => { if (SKIP) return; clientA?.close(); clientB?.close(); srv?.close(); await new Promise((r) => setTimeout(r, 1200)); await mongoose.connection.dropDatabase().catch(() => {}); await mongoose.disconnect(); });

test('فوروارد عادی: «فوروارد از نام فرستنده‌ی اصلی» با نام و عنوان چت مبدأ', { skip: SKIP }, async () => {
  const m = await post(clientA, src._id, 'سلام از گروه');
  const r = await fwd(m._id, [dst._id]);
  assert.ok(r.ok, JSON.stringify(r));
  const f = r.forwarded[0];
  assert.equal(f.content, 'سلام از گروه');
  assert.equal(f.forwardedFrom.originalSender.displayName, 'Alice');
  assert.equal(f.forwardedFrom.originalChat.title, 'Source');
  await new Promise((x) => setTimeout(x, 300));
  assert.ok(gotB.find((g) => g._id === f._id), 'گیرنده فوروارد را نگرفت');
});

test('hideSender: پیام بدون هیچ برچسب فوروارد (کپی) ارسال می‌شود', { skip: SKIP }, async () => {
  const m = await post(clientA, src._id, 'بدون نام');
  const r = await fwd(m._id, [dst._id], { hideSender: true });
  assert.ok(r.ok);
  const f = r.forwarded[0];
  assert.equal(f.content, 'بدون نام');
  assert.ok(!f.forwardedFrom || (!f.forwardedFrom.originalSender && !f.forwardedFrom.originalChat), JSON.stringify(f.forwardedFrom));
  const doc = await Message.findById(f._id).lean();
  assert.ok(!doc.forwardedFrom?.originalSender && !doc.forwardedFrom?.originalChat);
});

test('از کانال: عنوان کانال نمایش داده می‌شود و فرستنده‌ی پست (ادمین) هرگز لو نمی‌رود', { skip: SKIP }, async () => {
  const m = await post(clientA, chan._id, 'خبر مهم');
  const r = await fwd(m._id, [dst._id]);
  const f = r.forwarded[0];
  assert.equal(f.forwardedFrom.originalChat.title, 'News');
  assert.equal(f.forwardedFrom.originalSender, null);
  assert.ok(!JSON.stringify(f.forwardedFrom).includes('Alice'));
});

test('پیام E2E (متن رمز سمت کلاینت) قابل فوروارد نیست؛ پیام خالی ساخته نمی‌شود', { skip: SKIP }, async () => {
  const m = await post(clientA, dst._id, '', { e2e: { senderDeviceId: 'd1', ciphertext: 'abc==', header: { n: 1 } } });
  const before = await Message.countDocuments({ chat: src._id });
  const r = await fwd(m._id, [src._id]);
  assert.equal(r.code, 'E2E_FORWARD'); assert.ok(r.error);
  assert.equal(await Message.countDocuments({ chat: src._id }), before);
});

test('پیام گروهِ رمزشده (Sender Key) و چت «مخفی» هم قابل فوروارد نیست', { skip: SKIP }, async () => {
  const g = await Message.create({ chat: src._id, sender: A._id, type: 'text', content: '', groupE2e: { ciphertext: 'zzz==', senderKeyId: 'k1' } });
  assert.equal((await fwd(g._id, [dst._id])).code, 'E2E_FORWARD');
  const sec = await Chat.create({ type: 'secret', members: [{ user: A._id }, { user: B._id }] });
  const sm = await Message.create({ chat: sec._id, sender: A._id, type: 'text', content: 'clientcipher' });
  assert.equal((await fwd(sm._id, [dst._id])).code, 'E2E_FORWARD');
});

test('رسانه‌ی E2E (mediaMeta.encrypted) هم رد می‌شود؛ رسانه‌ی عادی فوروارد می‌شود', { skip: SKIP }, async () => {
  const enc = await post(clientA, dst._id, '', { type: 'image', mediaUrl: 'http://h/u/x.bin', mediaMeta: { encrypted: true } });
  assert.equal((await fwd(enc._id, [src._id])).code, 'E2E_FORWARD');
  const plain = await post(clientA, src._id, '', { type: 'image', mediaUrl: 'http://h/u/y.jpg', mediaMeta: { fileName: 'y.jpg' } });
  const r = await fwd(plain._id, [dst._id]);
  assert.ok(r.ok); assert.equal(r.forwarded[0].mediaUrl, 'http://h/u/y.jpg');
});

test('امنیت: پیام چتی که عضوش نیستی و چتِ مقصدی که عضوش نیستی', { skip: SKIP }, async () => {
  const secret = await Message.create({ chat: foreign._id, sender: C._id, type: 'text', content: 'secret' });
  assert.equal((await fwd(secret._id, [dst._id])).error, 'دسترسی ندارید');
  const m = await post(clientA, src._id, 'x');
  const r = await fwd(m._id, [foreign._id]); // عضو مقصد نیستی: بی‌صدا رد می‌شود
  assert.ok(r.ok); assert.equal(r.forwarded.length, 0);
});

test('چند مقصد هم‌زمان؛ تاریخچه‌ی چت (GET messages) هم نام فوروارد را دارد', { skip: SKIP }, async () => {
  const m = await post(clientA, src._id, 'چندمقصده');
  const r = await fwd(m._id, [dst._id, chan._id]);
  assert.equal(r.forwarded.length, 2);
  const stored = await Message.findById(r.forwarded[0]._id).populate('forwardedFrom.originalSender', 'displayName').lean();
  assert.equal(stored.forwardedFrom.originalSender.displayName, 'Alice');
});
