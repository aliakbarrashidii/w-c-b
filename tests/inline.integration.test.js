// تست یکپارچه‌ی ربات inline (مسیر واقعی + سوکت و دیتابیس واقعی): ربات commands، ربات webhook (answerInlineQuery)،
// تایم‌اوت، امنیت (عضویت/جعل/ربات خاموش)، و «via @bot» روی پیام.
// اجرا:  TEST_MONGO_URI=mongodb://127.0.0.1:27017 node --test --test-force-exit tests/inline.integration.test.js
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
const Bot = require('../src/models/Bot');
const engine = require('../src/utils/botEngine');

let srv; let port; let base; let A; let X; let cmdBotUser; let hookBotUser; let cmdBot; let hookBot; let hookToken; let chat; let cA; const got = [];
const tok = (u) => jwt.sign({ id: String(u._id), role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const open = (u) => new Promise((resolve, reject) => {
  const c = connect(`http://127.0.0.1:${port}`, { auth: { token: tok(u) }, transports: ['websocket'], reconnection: false });
  c.on('connect', () => resolve(c)); c.on('connect_error', reject);
});
const inline = (user, body) => fetch(`${base}/api/bots/inline-query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok(user)}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const botApi = (token, method, body) => fetch(`${base}/bot-api/${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const ask = (client, ev, payload) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`ack نیامد: ${ev}`)), 5000); client.emit(ev, payload, (res) => { clearTimeout(t); resolve(res); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mkBot = async (username, type, extra = {}) => {
  const u = await User.create({ username, displayName: username, passwordHash: 'x', isBot: true });
  const token = engine.newToken(u._id);
  const b = await Bot.create({ user: u._id, owner: A._id, tokenHash: engine.hashToken(token), type, ...extra });
  return { u, b, token };
};

test.before(async () => {
  if (SKIP) return;
  await mongoose.connect(process.env.TEST_MONGO_URI, { dbName: `wizinline_${Date.now()}` });
  await Promise.all([User, Chat, Message, Bot, require('../src/models/BotUpdate')].map((M) => M.init().catch(() => {})));
  A = await User.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x' });
  X = await User.create({ username: 'xavier', displayName: 'Xavier', passwordHash: 'x' });
  const c = await mkBot('price_bot', 'commands', {
    inline: { enabled: true, placeholder: 'نام ارز' },
    commands: [{ command: 'dollar', description: 'قیمت دلار', reply: 'دلار: ۱۰۰ {args}' }, { command: 'euro', description: 'قیمت یورو', reply: 'یورو: ۱۱۰' }],
  });
  cmdBotUser = c.u; cmdBot = c.b;
  const h = await mkBot('echo_bot', 'webhook', { inline: { enabled: true, placeholder: 'متن' } });
  hookBotUser = h.u; hookBot = h.b; hookToken = h.token;
  chat = await Chat.create({ type: 'private', members: [{ user: A._id }, { user: cmdBotUser._id }] });
  const app = express(); app.use(express.json());
  srv = http.createServer(app);
  const io = new Server(srv, { cors: { origin: '*' } });
  app.set('io', io);
  app.use('/api/bots', require('../src/routes/bots'));
  app.use('/bot-api', require('../src/routes/botApi'));
  require('../src/socket')(io);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port; base = `http://127.0.0.1:${port}`;
  cA = await open(A);
  cA.on('message:new', (m) => got.push(m));
});
test.after(async () => {
  if (SKIP) return;
  cA?.close(); srv?.close();
  await new Promise((r) => setTimeout(r, 1500));
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
});

test('ربات commands: بدون query همه، با query فیلتر؛ placeholder و اطلاعات ربات برمی‌گردد', { skip: SKIP }, async () => {
  const all = await inline(A, { username: '@Price_Bot', query: '', chatId: String(chat._id) });
  assert.equal(all.status, 200);
  assert.deepEqual(all.json.results.map((r) => r.id), ['cmd:dollar', 'cmd:euro']);
  assert.equal(all.json.placeholder, 'نام ارز');
  assert.equal(all.json.bot.username, 'price_bot');
  const f = await inline(A, { username: 'price_bot', query: 'یورو', chatId: String(chat._id) });
  assert.deepEqual(f.json.results.map((r) => r.id), ['cmd:euro']);
  assert.equal(f.json.results[0].message_text, 'یورو: ۱۱۰');
});

test('ربات webhook: query به ربات می‌رسد، answerInlineQuery نتیجه را برمی‌گرداند (نتیجه‌ی ناقص/thumb پاک می‌شود)', { skip: SKIP }, async () => {
  const pending = inline(A, { username: 'echo_bot', query: 'سلام', chatId: String(chat._id) });
  // ربات از طریق getUpdates پرس‌وجو را می‌گیرد و جواب می‌دهد
  let upd;
  for (let i = 0; i < 20 && !upd; i++) {
    await wait(150);
    const r = await botApi(hookToken, 'getUpdates', {});
    upd = (r.json?.result || []).find((u) => u.inline_query);
  }
  assert.ok(upd, 'ربات inline_query را نگرفت');
  assert.equal(upd.inline_query.query, 'سلام');
  assert.equal(upd.inline_query.from.username, 'alice');
  assert.equal(upd.inline_query.chat_type, 'private');
  const ans = await botApi(hookToken, 'answerInlineQuery', { inline_query_id: upd.inline_query.id, results: [{ id: '1', title: 'echo', message_text: 'سلام!', thumb_url: 'http://evil/x.png' }, { id: '2', title: '', message_text: 'x' }] });
  assert.equal(ans.status, 200);
  const res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.results.map((r) => r.id), ['1']);
  assert.equal(res.json.results[0].thumb_url, undefined);
  // جواب دوباره/نامعتبر رد می‌شود
  assert.equal((await botApi(hookToken, 'answerInlineQuery', { inline_query_id: upd.inline_query.id, results: [] })).status, 400);
  assert.equal((await botApi(hookToken, 'answerInlineQuery', { results: [] })).status, 400);
});

test('ربات webhook که جواب نمی‌دهد: timeout با نتیجه‌ی خالی', { skip: SKIP }, async () => {
  const t0 = Date.now();
  const r = await inline(A, { username: 'echo_bot', query: 'بی‌جواب', chatId: String(chat._id) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results, []); assert.equal(r.json.timeout, true);
  assert.ok(Date.now() - t0 >= 4500 && Date.now() - t0 < 9000);
});

test('امنیت: غیرعضو، ربات بدون inline/خاموش/ناشناس، ورودی خراب', { skip: SKIP }, async () => {
  assert.equal((await inline(X, { username: 'price_bot', query: '', chatId: String(chat._id) })).status, 403);   // X عضو چت نیست
  assert.equal((await inline(A, { username: 'price_bot', query: '' })).status, 403);                              // بدون chatId
  assert.equal((await inline(A, { username: 'not_a_name', query: '', chatId: String(chat._id) })).status, 400);
  assert.equal((await inline(A, { username: 'alice', query: '', chatId: String(chat._id) })).status, 400);        // alice به bot ختم نمی‌شود
  assert.equal((await inline(A, { username: 'ghost_bot', query: '', chatId: String(chat._id) })).status, 404);
  assert.equal((await inline(A, { username: 'price_bot', query: 'x'.repeat(300), chatId: String(chat._id) })).status, 400);
  await Bot.updateOne({ _id: cmdBot._id }, { 'inline.enabled': false });
  assert.equal((await inline(A, { username: 'price_bot', query: '', chatId: String(chat._id) })).status, 404);
  await Bot.updateOne({ _id: cmdBot._id }, { 'inline.enabled': true, active: false });
  assert.equal((await inline(A, { username: 'price_bot', query: '', chatId: String(chat._id) })).status, 404);
  await Bot.updateOne({ _id: cmdBot._id }, { active: true });
  assert.equal((await inline(A, { username: 'price_bot', query: '', chatId: String(chat._id) })).status, 200);
});

test('محدودیت نرخ: بعد از ۳۰ درخواست در دقیقه ۴۲۹', { skip: SKIP }, async () => {
  let last;
  for (let i = 0; i < 35; i++) last = await inline(A, { username: 'price_bot', query: '', chatId: String(chat._id) });
  assert.equal(last.status, 429);
});

test('«via @bot»: فقط برای ربات inline واقعی ذخیره می‌شود؛ جعل/کاربر عادی نادیده گرفته می‌شود', { skip: SKIP }, async () => {
  const send = (extra, content) => ask(cA, 'message:send', { chatId: String(chat._id), type: 'text', content, clientId: `i${Date.now()}${Math.random()}`, ...extra });
  const ok = await send({ inlineVia: String(cmdBotUser._id) }, 'نتیجه');
  assert.ok(ok.ok);
  const doc = await Message.findById(ok.message._id);
  assert.equal(String(doc.inlineVia.user), String(cmdBotUser._id)); assert.equal(doc.inlineVia.username, 'price_bot');
  assert.equal(ok.message.inlineVia.username, 'price_bot');
  const human = await send({ inlineVia: String(X._id) }, 'جعل با کاربر عادی');
  assert.equal((await Message.findById(human.message._id)).inlineVia, undefined);
  const junk = await send({ inlineVia: 'not-an-id' }, 'شناسه‌ی خراب');
  assert.ok(junk.ok); assert.equal((await Message.findById(junk.message._id)).inlineVia, undefined);
  await Bot.updateOne({ _id: cmdBot._id }, { 'inline.enabled': false });
  const off = await send({ inlineVia: String(cmdBotUser._id) }, 'ربات inline خاموش');
  assert.equal((await Message.findById(off.message._id)).inlineVia, undefined);
  const notText = await ask(cA, 'message:send', { chatId: String(chat._id), type: 'location', content: '{}', inlineVia: String(hookBotUser._id), clientId: `i${Date.now()}z` });
  assert.equal((await Message.findById(notText.message._id)).inlineVia, undefined);                                // فقط متن
});
