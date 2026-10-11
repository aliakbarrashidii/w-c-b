// تست یکپارچه‌ی پاک‌سازی داده‌ها روی یک MongoDB واقعی (درون‌حافظه‌ای). اجرا:  npm install && npm test
// نیاز به دسترسی اینترنت برای دانلود باینری mongod در اولین اجرا (mongodb-memory-server).
// ⚠️ این فایل در محیط ساخت (بدون دسترسی به mongod) فقط با `node --check` از نظر نحوی بررسی شده؛ اجرای واقعی‌اش با شماست.
process.env.JWT_SECRET = 'test';
process.env.MESSAGE_ENCRYPTION_KEY = 'a'.repeat(64);

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const User = require('../src/models/User');
const Chat = require('../src/models/Chat');
const Message = require('../src/models/Message');
const Bot = require('../src/models/Bot');
const BotMemory = require('../src/models/BotMemory');
const Session = require('../src/models/Session');
const cleanup = require('../src/utils/dataCleanup');

const UPLOADS = path.join(__dirname, '..', 'uploads');
let mongod;
let n = 0;
const uid = () => `u${Date.now()}${n++}`;
const mkUser = (extra = {}) => User.create({ username: uid(), displayName: 'U', passwordHash: 'x', ...extra });
const mkFile = (name) => { fs.mkdirSync(UPLOADS, { recursive: true }); fs.writeFileSync(path.join(UPLOADS, name), 'x'); return `http://localhost/uploads/${name}`; };
const exists = (name) => fs.existsSync(path.join(UPLOADS, name));

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([User.init(), Chat.init(), Message.init(), BotMemory.init()]);
});
test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test('purgeChats: پیام‌ها و فایل پاک می‌شن، اما فایلِ مشترک با چت دیگه می‌مونه', async () => {
  const a = await mkUser(); const b = await mkUser();
  const g1 = await Chat.create({ type: 'group', title: 'g1', members: [{ user: a._id, role: 'owner' }, { user: b._id }] });
  const g2 = await Chat.create({ type: 'group', title: 'g2', members: [{ user: a._id, role: 'owner' }] });
  const own = mkFile(`t-own-${n}.png`); const shared = mkFile(`t-shared-${n}.png`);
  const ownName = path.basename(own); const sharedName = path.basename(shared);
  await Message.create({ chat: g1._id, sender: a._id, type: 'image', mediaUrl: own });
  await Message.create({ chat: g1._id, sender: a._id, type: 'image', mediaUrl: shared });
  await Message.create({ chat: g2._id, sender: a._id, type: 'image', mediaUrl: shared }); // فوروارد = همون URL
  await BotMemory.create({ bot: new mongoose.Types.ObjectId(), chat: g1._id, messages: [] });

  await cleanup.purgeChats([g1._id]);

  assert.equal(await Chat.countDocuments({ _id: g1._id }), 0);
  assert.equal(await Message.countDocuments({ chat: g1._id }), 0);
  assert.equal(await BotMemory.countDocuments({ chat: g1._id }), 0);
  assert.equal(exists(ownName), false, 'فایلِ فقط‌مالِ این چت باید پاک بشه');
  assert.equal(exists(sharedName), true, 'فایلِ مشترک با g2 نباید پاک بشه');
  await cleanup.purgeChats([g2._id]);
  assert.equal(exists(sharedName), false, 'بعد از پاک شدن آخرین ارجاع، فایل باید پاک بشه');
});

test('purgeBot: چت خصوصی با ربات و حافظه پاک؛ عضویت در گروه برداشته؛ پیام ربات در گروه می‌مونه', async () => {
  const owner = await mkUser(); const other = await mkUser();
  const botUser = await mkUser({ isBot: true });
  const bot = await Bot.create({ user: botUser._id, owner: owner._id, tokenHash: `h${n++}`, type: 'agent' });
  const priv = await Chat.create({ type: 'private', members: [{ user: other._id }, { user: botUser._id }] });
  const grp = await Chat.create({ type: 'group', title: 'g', members: [{ user: owner._id, role: 'owner' }, { user: botUser._id }] });
  await Message.create({ chat: priv._id, sender: other._id, content: 'hi' });
  const inGroup = await Message.create({ chat: grp._id, sender: botUser._id, content: 'bot says' });
  await BotMemory.create({ bot: bot._id, chat: priv._id, messages: [{ role: 'user', content: 'x' }] });

  await cleanup.purgeBot(bot);

  assert.equal(await Chat.countDocuments({ _id: priv._id }), 0);
  assert.equal(await Message.countDocuments({ chat: priv._id }), 0);
  assert.equal(await BotMemory.countDocuments({ bot: bot._id }), 0);
  assert.equal(await Bot.countDocuments({ _id: bot._id }), 0);
  assert.equal(await User.countDocuments({ _id: botUser._id }), 0);
  const g = await Chat.findById(grp._id);
  assert.equal(g.members.some((m) => String(m.user) === String(botUser._id)), false);
  assert.equal(await Message.countDocuments({ _id: inGroup._id }), 1);
});

test('purgeIfAbandoned: فقط وقتی همه‌ی اعضا تاریخچه رو پاک کردن', async () => {
  const a = await mkUser(); const b = await mkUser();
  const past = new Date(Date.now() - 5000);
  const later = new Date();
  const c1 = await Chat.create({ type: 'private', lastActivityAt: past, members: [{ user: a._id, clearedAt: later }, { user: b._id }] });
  assert.equal(await cleanup.purgeIfAbandoned(await Chat.findById(c1._id)), false);
  assert.equal(await Chat.countDocuments({ _id: c1._id }), 1);
  const c2 = await Chat.create({ type: 'private', lastActivityAt: past, members: [{ user: a._id, clearedAt: later }, { user: b._id, clearedAt: later }] });
  assert.equal(await cleanup.purgeIfAbandoned(await Chat.findById(c2._id)), true);
  assert.equal(await Chat.countDocuments({ _id: c2._id }), 0);
  const c3 = await Chat.create({ type: 'private', lastActivityAt: past, members: [{ user: a._id, clearedAt: later, wallpaper: 'w1' }, { user: b._id, clearedAt: later }] });
  assert.equal(await cleanup.purgeIfAbandoned(await Chat.findById(c3._id)), false, 'تنظیم شخصی (والپیپر) باید حفظ بشه');
});

test('تایمر حذف خودکار: پیام جدید expiresAt می‌گیره (و در چت مخفی نه)', async () => {
  const a = await mkUser();
  const g = await Chat.create({ type: 'group', title: 'g', autoDeleteSec: 3600, members: [{ user: a._id, role: 'owner' }] });
  const m = await Message.create({ chat: g._id, sender: a._id, content: 'x' });
  const delta = new Date(m.expiresAt).getTime() - Date.now();
  assert.ok(delta > 3500 * 1000 && delta <= 3600 * 1000, `expiresAt نامعتبر: ${delta}`);
  const s = await Chat.create({ type: 'secret', autoDeleteSec: 3600, members: [{ user: a._id }] });
  const m2 = await Message.create({ chat: s._id, sender: a._id, content: 'x' });
  assert.equal(m2.expiresAt ?? null, null);
});

test('purgeUserAccount: ناشناس‌سازی، انتقال مالکیت، حذف چت خصوصی و نشست‌ها', async () => {
  const me = await mkUser({ phone: '+98900', phoneHash: `ph${n++}`, bio: 'secret bio' });
  const friend = await mkUser();
  await Session.create({ user: me._id });
  const grp = await Chat.create({ type: 'group', title: 'g', members: [{ user: me._id, role: 'owner' }, { user: friend._id, role: 'member' }] });
  const priv = await Chat.create({ type: 'private', members: [{ user: me._id }, { user: friend._id }] });
  const alone = await Chat.create({ type: 'group', title: 'solo', members: [{ user: me._id, role: 'owner' }] });

  await cleanup.purgeUserAccount(me._id, null);

  const u = await User.findById(me._id);
  assert.equal(u.status, 'deleted');
  assert.equal(u.displayName, 'Deleted Account');
  assert.equal(u.bio, '');
  assert.equal(u.phone, '');
  assert.equal(u.phoneHash, undefined);
  assert.match(u.username, /^deleted_/);
  const g = await Chat.findById(grp._id);
  assert.equal(g.members.length, 1);
  assert.equal(String(g.members[0].user), String(friend._id));
  assert.equal(g.members[0].role, 'owner', 'مالکیت باید منتقل بشه');
  assert.equal(await Chat.countDocuments({ _id: priv._id }), 0);
  assert.equal(await Chat.countDocuments({ _id: alone._id }), 0, 'گروهِ بی‌عضو انسانی باید پاک بشه');
  assert.equal(await Session.countDocuments({ user: me._id }), 0);
});

// ---------- کنترل دسترسی (IDOR) ----------
// این تست‌ها منطق «اتمی» رو روی DB چک می‌کنن؛ خودِ هندلرهای سوکت/HTTP (که به Express/socket.io وصلن) با supertest یا تست دستی روی گوشی
// باید امتحان بشن: فوروارد/ریپلای/ری‌اکشن/ریویل بدون عضویت، pin پیامِ چت دیگه، verify-passphrase/secret-ttl بدون عضویت.
test('Chat.exists با members.user: عضو/غیرعضو درست تشخیص داده می‌شه (هسته‌ی isMemberOf)', async () => {
  const a = await mkUser(); const b = await mkUser(); const outsider = await mkUser();
  const c = await Chat.create({ type: 'group', title: 'g', members: [{ user: a._id, role: 'owner' }, { user: b._id }] });
  assert.ok(await Chat.exists({ _id: c._id, 'members.user': a._id }));
  assert.ok(await Chat.exists({ _id: c._id, 'members.user': b._id }));
  assert.equal(await Chat.exists({ _id: c._id, 'members.user': outsider._id }), null);
});

test('پین چندتایی: unpinMessages از هر دو ساختار (تکی و لیست) پاک می‌کنه', async () => {
  const a = await mkUser();
  const c = await Chat.create({ type: 'group', title: 'g', members: [{ user: a._id, role: 'owner' }] });
  const m1 = await Message.create({ chat: c._id, sender: a._id, content: '1' });
  const m2 = await Message.create({ chat: c._id, sender: a._id, content: '2' });
  await Chat.updateOne({ _id: c._id }, { pinnedMessage: m2._id, pinnedMessages: [m1._id, m2._id] });
  await cleanup.unpinMessages([m2._id]);
  const after = await Chat.findById(c._id);
  assert.equal(after.pinnedMessage, null);
  assert.deepEqual(after.pinnedMessages.map(String), [String(m1._id)]);
});
