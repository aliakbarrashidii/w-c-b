// تست یکپارچه‌ی قابلیت‌های چت (روترها و هندلرهای واقعی + دیتابیس واقعی):
// نقل‌قول بخشی از پیام، «چه کسانی خواندند» + حریم رسید خوانده‌شدن، حریم «چه کسی می‌تواند من را به گروه اضافه کند»، «مزاحم نشوید»، جستجوی GIF.
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
// پوش را قبل از لود سوکت جایگزین می‌کنیم (سوکت هنگام لود destructure می‌کند)
const pushCalls = [];
const push = require('../src/utils/push');
push.sendPushNotifications = (tokens, payload) => { pushCalls.push({ tokens, payload }); };

const User = require('../src/models/User');
const Chat = require('../src/models/Chat');
const Message = require('../src/models/Message');

let srv; let port; let base; let A; let B; let C; let D; let grp; let priv; let gifFetches = 0; let gifKey = 'K'; const sockets = [];
const tok = (u) => jwt.sign({ id: String(u._id), role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const open = (u) => new Promise((res, rej) => { const c = connect(`http://127.0.0.1:${port}`, { auth: { token: tok(u) }, transports: ['websocket'], reconnection: false }); c.on('connect', () => { sockets.push(c); res(c); }); c.on('connect_error', rej); });
const ask = (client, ev, payload, ms = 5000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`ack نیامد: ${ev}`)), ms); client.emit(ev, payload, (r) => { clearTimeout(t); res(r); }); });
const api = async (method, path, user, body) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok(user)}` }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
};
let n = 0; const cid = () => `c${Date.now()}_${n++}`;
const send = async (client, chatId, content, extra = {}) => (await ask(client, 'message:send', { chatId: String(chatId), type: 'text', content, clientId: cid(), ...extra })).message;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let cA; let cB; let cC;

test.before(async () => {
  if (SKIP) return;
  await mongoose.connect(process.env.TEST_MONGO_URI, { dbName: `wizcf_${Date.now()}` });
  await Promise.all([User, Chat, Message].map((M) => M.init().catch(() => {})));
  const mk = (u, extra = {}) => User.create({ username: u, displayName: u[0].toUpperCase() + u.slice(1), passwordHash: 'x', ...extra });
  A = await mk('alice'); B = await mk('bob', { pushTokens: ['ExponentPushToken[b]'] }); C = await mk('carol'); D = await mk('dave');
  grp = await Chat.create({ type: 'group', title: 'G', members: [{ user: A._id, role: 'owner' }, { user: B._id }, { user: C._id }] });
  priv = await Chat.create({ type: 'private', members: [{ user: A._id }, { user: B._id }] });
  const app = express(); app.use(express.json());
  srv = http.createServer(app); const io = new Server(srv, { cors: { origin: '*' } }); app.set('io', io);
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/chats', require('../src/routes/chats'));
  app.use('/api/gifs', require('../src/routes/gifs').createGifRouter({
    getKey: () => gifKey,
    fetchJson: async (url) => { gifFetches++; return { data: [{ id: 'g1', title: 'Cat', images: { downsized_medium: { url: 'https://media1.giphy.com/a.gif', width: '100', height: '80', size: '1000' }, fixed_width_small: { url: 'https://media1.giphy.com/s.gif' } } }], pagination: { offset: 0, count: 1, total_count: 1 } }; },
  }));
  require('../src/socket')(io);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); port = srv.address().port; base = `http://127.0.0.1:${port}`;
  cA = await open(A);
});
test.after(async () => { if (SKIP) return; sockets.forEach((s) => s.close()); srv?.close(); await new Promise((r) => setTimeout(r, 1200)); await mongoose.connection.dropDatabase().catch(() => {}); await mongoose.disconnect(); });

// ---------------- نقل‌قول بخشی از پیام ----------------
test('نقل‌قول: فقط بازه‌ی نویسه‌ها ذخیره می‌شود (نه متن)؛ نامعتبر یا بدون replyTo دور ریخته می‌شود', { skip: SKIP }, async () => {
  const orig = await send(cA, grp._id, 'این یک پیام طولانی برای نقل‌قول است');
  const ok = await send(cA, grp._id, 'جواب', { replyTo: orig._id, replyQuote: { start: 3, end: 8, text: 'LEAK' } });
  assert.deepEqual({ ...ok.replyQuote }, { start: 3, end: 8 });
  const stored = await Message.findById(ok._id).lean();
  assert.deepEqual({ ...stored.replyQuote }, { start: 3, end: 8 }); assert.ok(!JSON.stringify(stored).includes('LEAK'));
  const bad = await send(cA, grp._id, 'نامعتبر', { replyTo: orig._id, replyQuote: { start: 9, end: 2 } });
  assert.ok(!bad.replyQuote);
  const noReply = await send(cA, grp._id, 'بدون پاسخ', { replyQuote: { start: 0, end: 3 } });
  assert.ok(!noReply.replyQuote); // بدون replyTo معنا ندارد
});

// ---------------- چه کسانی خواندند ----------------
test('readers: فقط فرستنده، رسید خاموش‌ها دیده نمی‌شوند، غیرعضو نمی‌تواند «خوانده شد» ثبت کند', { skip: SKIP }, async () => {
  cB = await open(B); cC = await open(C);
  await User.updateOne({ _id: C._id }, { 'privacy.readReceiptsEnabled': false }); // کارول رسیدش را خاموش کرده
  const m = await send(cA, grp._id, 'کی دید؟');
  cB.emit('message:read', { chatId: String(grp._id), messageId: String(m._id) });
  cC.emit('message:read', { chatId: String(grp._id), messageId: String(m._id) });
  const dave = await open(D); dave.emit('message:read', { chatId: String(grp._id), messageId: String(m._id) }); // غیرعضو
  await wait(500);
  const doc = await Message.findById(m._id).lean();
  const who = (doc.readBy || []).map((r) => String(r.user));
  assert.deepEqual(who, [String(B._id)], 'فقط باب باید ثبت شود (کارول رسید خاموش، دیو غیرعضو)');

  const r = await api('GET', `/chats/${grp._id}/messages/${m._id}/readers`, A);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.readers.map((x) => x.user.displayName), ['Bob']); assert.equal(r.json.totalMembers, 2);
  assert.equal((await api('GET', `/chats/${grp._id}/messages/${m._id}/readers`, B)).json.code, 'NOT_SENDER');          // فقط فرستنده
  assert.equal((await api('GET', `/chats/${grp._id}/messages/${m._id}/readers`, D)).status, 403);                       // غیرعضو
  const pm = await send(cA, priv._id, 'خصوصی');
  assert.equal((await api('GET', `/chats/${priv._id}/messages/${pm._id}/readers`, A)).json.code, 'NOT_GROUP');          // فقط گروه
  await User.updateOne({ _id: A._id }, { 'privacy.readReceiptsEnabled': false });
  assert.equal((await api('GET', `/chats/${grp._id}/messages/${m._id}/readers`, A)).json.code, 'RECEIPTS_OFF');         // تقابلی
  await User.updateOne({ _id: A._id }, { 'privacy.readReceiptsEnabled': true });
});
test('readers: گروه بزرگ (بیش از ۱۰۰ عضو) مجاز نیست', { skip: SKIP }, async () => {
  const big = await Chat.create({ type: 'group', title: 'Big', members: [{ user: A._id, role: 'owner' }, ...Array.from({ length: 100 }, () => ({ user: new mongoose.Types.ObjectId() }))] });
  const m = await Message.create({ chat: big._id, sender: A._id, type: 'text', content: 'x' });
  assert.equal((await api('GET', `/chats/${big._id}/messages/${m._id}/readers`, A)).json.code, 'TOO_MANY_MEMBERS');
});

// ---------------- حریم «چه کسی می‌تواند من را به گروه اضافه کند» ----------------
test('groupAdd: ساخت گروه و افزودن عضو، حریم هر کاربر را رعایت می‌کند و ردشده‌ها گزارش می‌شوند', { skip: SKIP }, async () => {
  const E = await User.create({ username: 'erin', displayName: 'Erin', passwordHash: 'x', privacy: { groupAdd: 'nobody' } });
  const F = await User.create({ username: 'frank', displayName: 'Frank', passwordHash: 'x', privacy: { groupAdd: 'contacts' } });
  const G2 = await User.create({ username: 'gina', displayName: 'Gina', passwordHash: 'x', privacy: { groupAdd: 'contacts' }, savedContacts: [{ contact: A._id, name: 'Alice' }] });
  const H = await User.create({ username: 'hank', displayName: 'Hank', passwordHash: 'x' }); // پیش‌فرض: همه
  const r = await api('POST', '/chats/group', A, { title: 'Privacy', memberIds: [E, F, G2, H].map((u) => String(u._id)) });
  assert.equal(r.status, 201);
  const ids = r.json.members.map((m) => String(m.user)).sort();
  assert.deepEqual(ids, [A, G2, H].map((u) => String(u._id)).sort(), 'فقط آلیس(مالک)، جینا(مخاطب)، هنک(همه)');
  assert.deepEqual(r.json.skippedMembers.map((s) => [s.userId, s.reason]).sort(), [[String(E._id), 'nobody'], [String(F._id), 'contacts']].sort());
  const add = await api('POST', `/chats/${r.json._id}/members`, A, { userIds: [String(E._id), String(F._id), String(D._id)] });
  assert.equal(add.status, 200);
  assert.ok(add.json.members.some((m) => String(m.user) === String(D._id)));
  assert.ok(!add.json.members.some((m) => String(m.user) === String(E._id)));
  assert.equal(add.json.skippedMembers.length, 2);
});
test('groupAdd: تنظیم از مسیر /me/privacy؛ مقدار نامعتبر رد می‌شود', { skip: SKIP }, async () => {
  assert.equal((await api('PATCH', '/auth/me/privacy', C, { groupAdd: 'nobody' })).status, 200);
  assert.equal((await User.findById(C._id).lean()).privacy.groupAdd, 'nobody');
  assert.equal((await api('PATCH', '/auth/me/privacy', C, { groupAdd: 'everyone-ish' })).status, 400);
});

// ---------------- مزاحم نشوید ----------------
test('DND: تنظیم از مسیر /me/notifications؛ نامعتبر رد می‌شود', { skip: SKIP }, async () => {
  const until = Date.now() + 3600_000;
  const r = await api('PATCH', '/auth/me/notifications', B, { dnd: { mode: 'until', until, allowCalls: true } });
  assert.equal(r.status, 200); assert.equal(r.json.notificationSettings.dnd.mode, 'until'); assert.equal(r.json.notificationSettings.dnd.allowCalls, true);
  assert.equal((await api('PATCH', '/auth/me/notifications', B, { dnd: { mode: 'until', until: Date.now() - 5 } })).status, 400);
  assert.equal((await api('PATCH', '/auth/me/notifications', B, { dnd: { mode: 'schedule', schedule: { from: '22:00', to: '22:00', days: [1] } } })).status, 400);
  await api('PATCH', '/auth/me/notifications', B, { dnd: { mode: 'off' } });
});
test('DND: پوش پیام فقط وقتی DND فعال نیست ارسال می‌شود (گیرنده آفلاین)', { skip: SKIP }, async () => {
  cB?.close(); await wait(300); // باب آفلاین شود تا مسیر پوش اجرا شود
  pushCalls.length = 0;
  await send(cA, priv._id, 'پیام عادی'); await wait(300);
  assert.equal(pushCalls.filter((c) => c.payload.data.recipientId === String(B._id)).length, 1, 'بدون DND باید پوش برود');
  await User.updateOne({ _id: B._id }, { 'notificationSettings.dnd': { mode: 'until', until: Date.now() + 3600_000 } });
  pushCalls.length = 0;
  await send(cA, priv._id, 'در DND'); await wait(300);
  assert.equal(pushCalls.length, 0, 'با DND فعال نباید پوش برود');
  await User.updateOne({ _id: B._id }, { 'notificationSettings.dnd': { mode: 'until', until: Date.now() - 1000 } });
  await send(cA, priv._id, 'DND تمام شده'); await wait(300);
  assert.equal(pushCalls.length, 1, 'بعد از پایان DND دوباره پوش می‌رود');
});

// ---------------- GIF ----------------
test('GIF: status، جستجو، کش، ورودی نامعتبر، بدون کلید (۵۰۱)', { skip: SKIP }, async () => {
  assert.equal((await api('GET', '/gifs/status', A)).json.enabled, true);
  const s = await api('GET', '/gifs/search?q=cat', A);
  assert.equal(s.status, 200); assert.equal(s.json.items[0].id, 'g1'); assert.equal(s.json.items[0].url, 'https://media1.giphy.com/a.gif');
  const before = gifFetches;
  await api('GET', '/gifs/search?q=cat', A); // از کش
  assert.equal(gifFetches, before);
  assert.equal((await api('GET', '/gifs/search?q=', A)).status, 400);
  assert.equal((await api('GET', '/gifs/trending', A)).status, 200);
  gifKey = '';
  assert.equal((await api('GET', '/gifs/status', A)).json.enabled, false);
  assert.equal((await api('GET', '/gifs/search?q=dog', A)).status, 501);
  gifKey = 'K';
  const noAuth = await fetch(`${base}/api/gifs/search?q=cat`); assert.equal(noAuth.status, 401);
});
