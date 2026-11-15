// تست یکپارچه‌ی «مسیر ارسال پیام» با هندلر واقعی سوکت + دیتابیس واقعی + کلاینت واقعی socket.io.
// اجرا:  TEST_MONGO_URI=mongodb://127.0.0.1:27017 npm run test:integration   (بدون TEST_MONGO_URI رد می‌شود)
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
const ScheduledMessage = require('../src/models/ScheduledMessage');

let srv; let port; let A; let B; let C; let chat; let group; let clientA; let clientB;
const received = [];
const tok = (u) => jwt.sign({ id: String(u._id), role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const open = (u) => new Promise((resolve, reject) => {
  const c = connect(`http://127.0.0.1:${port}`, { auth: { token: tok(u) }, transports: ['websocket'], reconnection: false });
  c.on('connect', () => resolve(c));
  c.on('connect_error', reject);
});
// ack با سقف زمان: «هیچ ack» = همان «ارسال نمی‌شود/گیر می‌کند» برای کاربر
const send = (client, payload, ms = 5000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`ack نیامد (${payload.type})`)), ms);
  client.emit('message:send', payload, (res) => { clearTimeout(t); resolve(res); });
});
let n = 0; const cid = () => `c${Date.now()}_${n++}`;

test.before(async () => {
  if (SKIP) return;
  await mongoose.connect(process.env.TEST_MONGO_URI, { dbName: `wizsend_${Date.now()}` });
  await Promise.all([User, Chat, Message, ScheduledMessage].map((M) => M.init().catch(() => {})));
  A = await User.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x' });
  B = await User.create({ username: 'bob', displayName: 'Bob', passwordHash: 'x' });
  C = await User.create({ username: 'carol', displayName: 'Carol', passwordHash: 'x' });
  chat = await Chat.create({ type: 'private', members: [{ user: A._id }, { user: B._id }] });
  group = await Chat.create({ type: 'group', title: 'g', members: [{ user: A._id, role: 'owner' }, { user: B._id }] });
  srv = http.createServer();
  const io = new Server(srv, { cors: { origin: '*' } });
  require('../src/socket')(io);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
  clientA = await open(A); clientB = await open(B);
  clientB.on('message:new', (m) => received.push(m));
});
test.after(async () => {
  if (SKIP) return;
  clientA?.close(); clientB?.close(); srv?.close();
  await new Promise((r) => setTimeout(r, 1500)); // راه‌اندازیِ پس‌زمینه‌ی اتصال‌ها (connectionSetup) تموم بشه قبل از بستن DB
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
});

test('متن ساده: ack موفق، ذخیره در DB، و دریافت توسط طرف مقابل', { skip: SKIP }, async () => {
  const clientId = cid();
  const res = await send(clientA, { chatId: String(chat._id), type: 'text', content: 'سلام', clientId });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.message.content, 'سلام');
  await new Promise((r) => setTimeout(r, 300));
  const got = received.find((m) => m.clientId === clientId);
  assert.ok(got, 'طرف مقابل message:new را نگرفت');
  assert.equal(got.content, 'سلام');
  assert.equal(await Message.countDocuments({ chat: chat._id, clientId }), 1);
});

test('انواع رسانه: تصویر، فایل، ویس، پیام ویدیویی، ویدیو - همه ack موفق می‌گیرند', { skip: SKIP }, async () => {
  const cases = [
    { type: 'image', mediaUrl: 'http://h/uploads/a.jpg', mediaMeta: { fileName: 'a.jpg', fileSizeBytes: 1234, mimeType: 'image/jpeg', width: 100, height: 80 } },
    { type: 'file', mediaUrl: 'http://h/uploads/b.pdf', mediaMeta: { fileName: 'b.pdf', fileSizeBytes: 99999, mimeType: 'application/pdf' } },
    { type: 'voice', mediaUrl: 'http://h/uploads/c.m4a', mediaMeta: { durationSec: 5, fileSizeBytes: 5000, mimeType: 'audio/m4a' } },
    { type: 'video_note', mediaUrl: 'http://h/uploads/d.mp4', mediaMeta: { durationSec: 3, fileSizeBytes: 90000, mimeType: 'video/mp4' } },
    { type: 'video', mediaUrl: 'http://h/uploads/e.mp4', mediaMeta: { durationSec: 9, fileSizeBytes: 900000, mimeType: 'video/mp4' } },
  ];
  for (const c of cases) {
    const res = await send(clientA, { chatId: String(chat._id), content: '', clientId: cid(), ...c });
    assert.ok(res.ok, `${c.type}: ${JSON.stringify(res)}`);
    assert.equal(res.message.type, c.type);
    assert.equal(res.message.mediaUrl, c.mediaUrl);
  }
});

test('استیکر: همان قالبی که کلاینت می‌فرستد ({type:"sticker", content: stickerId})', { skip: SKIP }, async () => {
  const res = await send(clientA, { chatId: String(chat._id), type: 'sticker', content: 'someStickerId123', clientId: cid() });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.message.content, 'someStickerId123');
});

test('پیام E2E (متن خالی + payload رمز): ack موفق و متن سرور خالی', { skip: SKIP }, async () => {
  const clientId = cid();
  const res = await send(clientA, { chatId: String(chat._id), type: 'text', content: '', clientId, e2e: { senderDeviceId: 'dev1', ciphertext: 'abc==', header: { n: 1 } } });
  assert.ok(res.ok, JSON.stringify(res));
  const doc = await Message.findOne({ chat: chat._id, clientId }).lean();
  assert.equal(doc.content, '');
  assert.equal(doc.e2e.senderDeviceId, 'dev1');
});

test('ارسال مجدد با همان clientId تکراری نمی‌سازد (بازارسال امن)', { skip: SKIP }, async () => {
  const clientId = cid();
  const first = await send(clientA, { chatId: String(chat._id), type: 'text', content: 'once', clientId });
  const second = await send(clientA, { chatId: String(chat._id), type: 'text', content: 'once', clientId });
  assert.ok(first.ok && second.ok);
  assert.equal(second.duplicate, true);
  assert.equal(await Message.countDocuments({ chat: chat._id, clientId }), 1);
});

test('ورودی نامعتبر همیشه ack می‌گیرد (هرگز گیر نمی‌کند): chatId خراب، غیرعضو، بدون chatId', { skip: SKIP }, async () => {
  const bad = await send(clientA, { chatId: 'not-an-id', type: 'text', content: 'x', clientId: cid() });
  assert.ok(bad.error, 'chatId خراب باید خطا بدهد');
  const none = await send(clientA, { type: 'text', content: 'x', clientId: cid() });
  assert.ok(none.error);
  const clientC = await open(C);
  try {
    const outsider = await send(clientC, { chatId: String(chat._id), type: 'text', content: 'x', clientId: cid() });
    assert.ok(outsider.error, 'غیرعضو باید رد شود');
  } finally { clientC.close(); }
});

test('پیام زمان‌بندی‌شده: آینده ← ذخیره در ScheduledMessage؛ گذشته ← فوراً ارسال', { skip: SKIP }, async () => {
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const res = await send(clientA, { chatId: String(chat._id), type: 'text', content: 'later', clientId: cid(), scheduledFor: future });
  assert.ok(res.ok && res.scheduled, JSON.stringify(res));
  assert.equal(await ScheduledMessage.countDocuments({ chat: chat._id, sender: A._id }), 1);
  const past = new Date(Date.now() - 1000).toISOString();
  const now = await send(clientA, { chatId: String(chat._id), type: 'text', content: 'now', clientId: cid(), scheduledFor: past });
  assert.ok(now.ok && !now.scheduled, JSON.stringify(now));
});

test('گروه: ریپلای معتبر، تاپیک معتبر/نامعتبر، ارسال بی‌صدا', { skip: SKIP }, async () => {
  group.topics.push({ title: 'T1' });
  await group.save();
  const topicId = String(group.topics[0]._id);
  const base = await send(clientA, { chatId: String(group._id), type: 'text', content: 'base', clientId: cid() });
  assert.ok(base.ok);
  const ok = await send(clientB, { chatId: String(group._id), type: 'text', content: 'r', clientId: cid(), replyTo: base.message._id, topicId, silent: true });
  assert.ok(ok.ok, JSON.stringify(ok));
  const doc = await Message.findById(ok.message._id).lean();
  assert.equal(String(doc.replyTo), base.message._id);
  assert.equal(String(doc.topic), topicId);
  const badTopic = await send(clientB, { chatId: String(group._id), type: 'text', content: 'x', clientId: cid(), topicId: String(new mongoose.Types.ObjectId()) });
  assert.ok(badTopic.ok);
  assert.equal((await Message.findById(badTopic.message._id).lean()).topic, undefined, 'تاپیکِ ناشناس ← پیام عمومی');
  const foreignReply = await send(clientB, { chatId: String(group._id), type: 'text', content: 'x', clientId: cid(), replyTo: String(chat._id) });
  assert.ok(foreignReply.ok);
  assert.equal((await Message.findById(foreignReply.message._id).lean()).replyTo ?? null, null, 'ریپلای به پیام چت دیگر نادیده گرفته می‌شود');
});

// ⚠️ تست رگرسیون باگِ «اولین پیام بعد از اتصال ack نمی‌گیرد»: سرور قبلاً هندلرها را بعد از چند await ثبت می‌کرد؛ رویدادی که کلاینت
// «همان لحظه‌ی connect» می‌فرستاد (مثل پیام‌های صف‌شده هنگام reconnect) دور ریخته می‌شد. این‌جا با کاربری که چت‌ها/پیام‌های معوق زیاد دارد
// پنجره‌ی مسابقه را عمداً بزرگ می‌کنیم و پیام را داخل خودِ callback ی connect می‌فرستیم.
test('پیامی که «همان لحظه‌ی اتصال» فرستاده شود ack می‌گیرد (مسابقه‌ی ثبت هندلر)', { skip: SKIP }, async () => {
  for (let i = 0; i < 25; i++) {
    const other = await User.create({ username: `u${Date.now()}_${i}`, displayName: `U${i}`, passwordHash: 'x' });
    const c = await Chat.create({ type: 'private', members: [{ user: A._id }, { user: other._id }] });
    await Message.create({ chat: c._id, sender: other._id, type: 'text', content: 'pending', clientId: cid() }); // پیام معوقِ تحویل‌نشده برای A
  }
  for (let round = 0; round < 3; round++) {
    const res = await new Promise((resolve, reject) => {
      const c = connect(`http://127.0.0.1:${port}`, { auth: { token: tok(A) }, transports: ['websocket'], reconnection: false });
      const t = setTimeout(() => { c.close(); reject(new Error('ack نیامد: پیامِ لحظه‌ی اتصال دور ریخته شد')); }, 5000);
      c.on('connect', () => c.emit('message:send', { chatId: String(chat._id), type: 'text', content: `fast${round}`, clientId: cid() }, (r) => { clearTimeout(t); c.close(); resolve(r); }));
      c.on('connect_error', reject);
    });
    assert.ok(res.ok, JSON.stringify(res));
  }
});

test('e2e خصوصی: فهرستِ دستگاهِ ناقص (کشِ کلاینت) ⇒ DEVICE_LIST_STALE با فهرستِ درست؛ کامل ⇒ ok', { skip: SKIP }, async () => {
  const Device = require('../src/models/Device');
  const dev = (user, deviceId) => ({ user: user._id, deviceId, identityKeyPub: 'k', identitySignKeyPub: 'k', signedPrekeyId: 1, signedPrekeyPub: 'k', signedPrekeySig: 'k' });
  await Device.deleteMany({});
  await Device.insertMany([dev(A, 'a1'), dev(B, 'b1')]);
  const wire = (ids) => ({ senderDeviceId: 'a1', payloads: ids.map((deviceId) => ({ deviceId, header: {}, nonce: 'n', ciphertext: 'c' })) });
  const base = () => ({ chatId: String(chat._id), type: 'text', content: '', clientId: cid() });
  // کاملِ کامل (فقط b1؛ دستگاهِ فرستنده a1 لازم نیست)
  assert.equal((await send(clientA, { ...base(), e2e: wire(['b1']) })).error, undefined);
  // مخاطب دستگاهِ تازه ثبت می‌کند، ولی کلاینت هنوز لیستِ قدیمی را در کش دارد
  await Device.create(dev(B, 'b2'));
  const stale = await send(clientA, { ...base(), e2e: wire(['b1']) });
  assert.equal(stale.code, 'DEVICE_LIST_STALE');
  assert.deepEqual(stale.devices[String(B._id)].sort(), ['b1', 'b2']);
  assert.equal(await Message.countDocuments({ chat: chat._id, clientId: { $exists: true }, 'e2e.payloads.0.deviceId': 'b1' }), 1); // پیامِ ناقص ذخیره نشد (فقط اولی)
  // بعد از رمزِ دوباره با فهرستِ درست
  assert.equal((await send(clientA, { ...base(), e2e: wire(['b1', 'b2']) })).error, undefined);
  // دستگاهِ دیگرِ خودِ فرستنده هم باید پوشش داده شود
  await Device.create(dev(A, 'a2'));
  assert.equal((await send(clientA, { ...base(), e2e: wire(['b1', 'b2']) })).code, 'DEVICE_LIST_STALE');
  assert.equal((await send(clientA, { ...base(), e2e: wire(['a2', 'b1', 'b2']) })).error, undefined);
  await Device.deleteMany({});
});
