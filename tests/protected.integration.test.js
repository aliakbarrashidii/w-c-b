// تست یکپارچه‌ی «محدودکردن ذخیره و فوروارد»: فقط مالک، رویداد زنده، پیام سرویس (فقط گروه)، و رد فوروارد از سرور.
// اجرا:  TEST_MONGO_URI=mongodb://127.0.0.1:27017 node --test --test-force-exit tests/protected.integration.test.js
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

let srv; let port; let base; let owner; let admin; let member; let group; let channel; let free; let cO; let cM; const evM = [];
const tok = (u) => jwt.sign({ id: String(u._id), role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const open = (u) => new Promise((resolve, reject) => {
  const c = connect(`http://127.0.0.1:${port}`, { auth: { token: tok(u) }, transports: ['websocket'], reconnection: false });
  c.on('connect', () => resolve(c)); c.on('connect_error', reject);
});
const ask = (client, ev, payload) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`ack نیامد: ${ev}`)), 5000); client.emit(ev, payload, (res) => { clearTimeout(t); resolve(res); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const patch = (u, chat, body) => fetch(`${base}/api/chats/${chat._id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok(u)}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
let n = 0;
const send = async (client, chat, content) => (await ask(client, 'message:send', { chatId: String(chat._id), type: 'text', content, clientId: `p${Date.now()}_${n++}` })).message;

test.before(async () => {
  if (SKIP) return;
  await mongoose.connect(process.env.TEST_MONGO_URI, { dbName: `wizprot_${Date.now()}` });
  await Promise.all([User, Chat, Message].map((M) => M.init().catch(() => {})));
  owner = await User.create({ username: 'olivia', displayName: 'Olivia', passwordHash: 'x' });
  admin = await User.create({ username: 'adam', displayName: 'Adam', passwordHash: 'x' });
  member = await User.create({ username: 'mia', displayName: 'Mia', passwordHash: 'x' });
  const mk = (type, title) => Chat.create({ type, title, members: [{ user: owner._id, role: 'owner' }, { user: admin._id, role: 'admin' }, { user: member._id, role: 'member' }] });
  group = await mk('group', 'G'); channel = await mk('channel', 'C'); free = await mk('group', 'Free');
  const app = express(); app.use(express.json());
  srv = http.createServer(app);
  const io = new Server(srv, { cors: { origin: '*' } });
  app.set('io', io);
  app.use('/api/chats', require('../src/routes/chats'));
  require('../src/socket')(io);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port; base = `http://127.0.0.1:${port}`;
  cO = await open(owner); cM = await open(member);
  for (const e of ['group:updated', 'message:new']) cM.on(e, (p) => evM.push({ e, p }));
});
test.after(async () => {
  if (SKIP) return;
  cO?.close(); cM?.close(); srv?.close();
  await new Promise((r) => setTimeout(r, 1500));
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
});

test('فقط مالک می‌تواند روشن کند (ادمین/عضو ۴۰۳)؛ رویداد زنده و پیام سرویس در گروه', { skip: SKIP }, async () => {
  assert.equal((await patch(admin, group, { protectedContent: true })).status, 403);
  assert.equal((await patch(member, group, { protectedContent: true })).status, 403);
  assert.equal((await Chat.findById(group._id)).protectedContent, false);
  const r = await patch(owner, group, { protectedContent: true });
  assert.equal(r.status, 200); assert.equal(r.json.protectedContent, true);
  await wait(400);
  assert.equal((await Chat.findById(group._id)).protectedContent, true);
  const upd = evM.find((x) => x.e === 'group:updated' && String(x.p.chatId) === String(group._id));
  assert.ok(upd); assert.equal(upd.p.protectedContent, true);
  const svc = evM.find((x) => x.e === 'message:new' && x.p.mediaMeta?.action === 'protected_content');
  assert.ok(svc, 'پیام سرویس نرسید');
  assert.equal(svc.p.mediaMeta.enabled, true); assert.equal(String(svc.p.sender._id), String(owner._id)); assert.equal(svc.p.type, 'system_action');
  const count = await Message.countDocuments({ chat: group._id, 'mediaMeta.action': 'protected_content' });
  await patch(owner, group, { protectedContent: true }); await wait(300);                       // همان مقدار: بی‌صدا
  assert.equal(await Message.countDocuments({ chat: group._id, 'mediaMeta.action': 'protected_content' }), count);
  await patch(owner, group, { title: 'G2' }); await wait(200);                                   // تغییر بی‌ربط: ماندگار
  assert.equal((await Chat.findById(group._id)).protectedContent, true);
});

test('کانال: مالک می‌تواند، ولی پیام سرویس نمی‌سازد (فرستنده لو نرود)', { skip: SKIP }, async () => {
  const before = await Message.countDocuments({ chat: channel._id });
  const r = await patch(owner, channel, { protectedContent: true });
  assert.equal(r.status, 200);
  await wait(400);
  assert.equal((await Chat.findById(channel._id)).protectedContent, true);
  assert.equal(await Message.countDocuments({ chat: channel._id }), before);
});

test('فوروارد از چت محافظت‌شده رد می‌شود (حتی به پیام‌های ذخیره‌شده/چت دیگر)؛ از چت آزاد کار می‌کند', { skip: SKIP }, async () => {
  const saved = await Chat.create({ type: 'saved', members: [{ user: member._id, role: 'owner' }] });
  const m = await send(cO, group, 'محرمانه');
  const blocked = await ask(cM, 'message:forward', { messageId: String(m._id), toChatIds: [String(free._id), String(saved._id)] });
  assert.equal(blocked.code, 'PROTECTED'); assert.ok(blocked.error); assert.equal(blocked.ok, undefined);
  assert.equal(await Message.countDocuments({ chat: free._id, forwardedFrom: { $exists: true } }), 0);
  assert.equal(await Message.countDocuments({ chat: saved._id }), 0);

  const m2 = await send(cO, free, 'آزاد');
  const ok = await ask(cM, 'message:forward', { messageId: String(m2._id), toChatIds: [String(saved._id)] });
  assert.ok(ok.ok); assert.equal(ok.forwarded.length, 1);

  await patch(owner, group, { protectedContent: false }); await wait(300);                       // خاموش‌کردن ← دوباره آزاد
  const again = await ask(cM, 'message:forward', { messageId: String(m._id), toChatIds: [String(saved._id)] });
  assert.ok(again.ok);
  const off = await Message.findOne({ chat: group._id, 'mediaMeta.action': 'protected_content', 'mediaMeta.enabled': false });
  assert.ok(off, 'پیام سرویسِ خاموش‌شدن ساخته نشد');
});

test('مقدار نامعتبر (غیربولین) نادیده گرفته می‌شود؛ چت خصوصی/غیرعضو رد', { skip: SKIP }, async () => {
  const before = (await Chat.findById(free._id)).protectedContent;
  const r = await patch(owner, free, { protectedContent: 'yes' });
  assert.equal(r.status, 200);
  assert.equal((await Chat.findById(free._id)).protectedContent, before);
  const priv = await Chat.create({ type: 'private', members: [{ user: owner._id }, { user: member._id }] });
  assert.equal((await patch(owner, priv, { protectedContent: true })).status, 404);
  const outsider = await User.create({ username: 'zed', displayName: 'Zed', passwordHash: 'x' });
  assert.equal((await patch(outsider, free, { protectedContent: true })).status, 403);
});
