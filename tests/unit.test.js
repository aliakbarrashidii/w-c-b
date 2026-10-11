// تست‌های واحدِ بدون DB و بدون شبکه برای منطق خالص این پروژه. اجرا: npm test
process.env.JWT_SECRET = 'test';
process.env.MESSAGE_ENCRYPTION_KEY = 'a'.repeat(64);
const test = require('node:test');
const assert = require('node:assert/strict');

test('isAbandoned: فقط وقتی همه‌ی اعضا تاریخچه رو پاک کردن و تنظیم شخصی ندارن', () => {
  const { isAbandoned } = require('../src/utils/dataCleanup');
  const t0 = Date.now() - 10000; const after = new Date(Date.now() - 5000); const before = new Date(Date.now() - 20000);
  const mk = (type, members) => ({ type, lastActivityAt: new Date(t0), members });
  assert.equal(isAbandoned(mk('private', [{ clearedAt: after }, { clearedAt: after }])), true);
  assert.equal(isAbandoned(mk('private', [{ clearedAt: after }, { clearedAt: null }])), false);
  assert.equal(isAbandoned(mk('private', [{ clearedAt: before }, { clearedAt: after }])), false, 'پاک‌کردن قبل از آخرین پیام');
  assert.equal(isAbandoned(mk('private', [{ clearedAt: after, wallpaper: 'w' }, { clearedAt: after }])), false);
  assert.equal(isAbandoned(mk('private', [{ clearedAt: after, pinnedInList: true }, { clearedAt: after }])), false);
  assert.equal(isAbandoned(mk('private', [{ clearedAt: after, markedUnread: true }, { clearedAt: after }])), false);
  assert.equal(isAbandoned(mk('private', [{ clearedAt: after, mutedUntil: new Date(Date.now() + 99999) }, { clearedAt: after }])), false);
  assert.equal(isAbandoned(mk('private', [{ clearedAt: after, mutedUntil: new Date(Date.now() - 99999) }, { clearedAt: after }])), true);
  assert.equal(isAbandoned(mk('group', [{ clearedAt: after }])), false, 'گروه هیچ‌وقت از این مسیر پاک نمی‌شه');
});

test('uploadPathFromUrl: فقط داخل uploads/، ضد path traversal', () => {
  const { uploadPathFromUrl } = require('../src/utils/dataCleanup');
  assert.match(uploadPathFromUrl('http://h:3000/uploads/abc-123.jpg'), /uploads[\\/]abc-123\.jpg$/);
  assert.equal(uploadPathFromUrl('https://evil.com/other/x.png'), null);
  assert.equal(uploadPathFromUrl('http://h/uploads/.env'), null);
  assert.equal(uploadPathFromUrl(''), null);
  assert.equal(uploadPathFromUrl(null), null);
  const p = uploadPathFromUrl('http://h/uploads/../../etc/passwd');
  assert.ok(p === null || /uploads[\\/][^\\/]+$/.test(p), 'traversal باید null یا فقط basename داخل uploads باشه');
  assert.match(uploadPathFromUrl('http://h/uploads/%2e%2e%2fsecret') || '', /uploads[\\/]secret$/);
});

test('safeUploadName: ۱۲۸ بیت تصادفی، پسوند امن، پسوند قابل‌اجرا → .bin، بدون تکرار', () => {
  const { safeUploadName } = require('../src/utils/uploadName');
  assert.match(safeUploadName('a.JPG'), /^[0-9a-f]{32}\.jpg$/);
  assert.match(safeUploadName('voice.m4a'), /^[0-9a-f]{32}\.m4a$/);
  for (const bad of ['x.html', 'y.svg', 'evil.php', 'a.js', 'long.abcdefghijk']) assert.match(safeUploadName(bad), /^[0-9a-f]{32}\.bin$/, bad);
  assert.match(safeUploadName('noext'), /^[0-9a-f]{32}$/);
  assert.equal(new Set(Array.from({ length: 3000 }, () => safeUploadName('a.png'))).size, 3000);
});

test('normalizeButtons: فقط http(s) و callback می‌مونن', () => {
  const { normalizeButtons } = require('../src/routes/botApi');
  const out = normalizeButtons([
    [{ text: 'ok', url: 'https://example.com/a?b=1' }, { text: 'tel', url: 'tel:+123' }],
    [{ text: 'intent', url: 'intent://x#Intent;end' }, { text: 'js', url: 'javascript:alert(1)' }],
    [{ text: 'file', url: 'file:///etc/passwd' }, { text: 'cb', callback_data: 'x' }],
    [{ text: 'http', url: 'http://a.b' }, { text: 'space', url: 'https://a b' }],
  ]);
  const flat = out.flat().map((b) => b.text);
  assert.deepEqual(flat, ['ok', 'cb', 'http']);
});

test('تایمر حذف خودکار (هوک ذخیره‌ی پیام): expiresAt فقط برای چت‌های تایمردار و غیرمخفی', async () => {
  const mongoose = require('mongoose');
  const Message = require('../src/models/Message');
  const Chat = require('../src/models/Chat');
  const original = Chat.findById;
  const run = async (chat, pre = {}) => {
    Chat.findById = () => ({ select: () => ({ lean: async () => chat }) });
    const m = new Message({ chat: new mongoose.Types.ObjectId(), sender: new mongoose.Types.ObjectId(), type: 'text', ...pre });
    const hook = Message.schema.s.hooks._pres.get('save').find((h) => h.fn.name === 'autoDeleteStamp');
    await hook.fn.call(m, () => {});
    return m.expiresAt;
  };
  try {
    const t0 = Date.now();
    const a = await run({ autoDeleteSec: 86400, type: 'private' });
    assert.equal(Math.round((a - t0) / 3600000), 24);
    assert.equal((await run({ autoDeleteSec: 0, type: 'private' })) ?? null, null);
    assert.equal((await run({ autoDeleteSec: 86400, type: 'secret' })) ?? null, null);
    assert.equal((await run({ autoDeleteSec: 86400, type: 'saved' })) ?? null, null);
    const keep = new Date(Date.now() + 5000);
    assert.equal(await run({ autoDeleteSec: 86400, type: 'group' }, { expiresAt: keep }), keep);
  } finally { Chat.findById = original; }
});

test('User: phoneHash/telegramId بدون مقدار پیش‌فرض (ایندکس partial) - کاربر بی‌تلفن چند‌تا می‌تونه باشه', () => {
  const User = require('../src/models/User');
  const u = new User({ username: 'x', displayName: 'y', passwordHash: 'z' }).toObject();
  assert.equal('phoneHash' in u, false);
  assert.equal('telegramId' in u, false);
  const idx = User.schema.indexes().filter((i) => i[0].phoneHash || i[0].telegramId);
  assert.equal(idx.length, 2);
  for (const [, opts] of idx) assert.ok(opts.partialFilterExpression && !opts.sparse, 'باید partial باشه نه sparse');
});

test('BotMemory: اسکیما معتبر و رمزنگاری رفت‌وبرگشت', () => {
  const mongoose = require('mongoose');
  const BotMemory = require('../src/models/BotMemory');
  const { encryptText, decryptText } = require('../src/utils/crypto');
  const doc = new BotMemory({ bot: new mongoose.Types.ObjectId(), chat: new mongoose.Types.ObjectId(), messages: [{ role: 'user', content: encryptText('سلام') }] });
  assert.equal(doc.validateSync(), undefined);
  assert.equal(decryptText(doc.messages[0].content), 'سلام');
});

test('لیست پین: سقف ۱۰، جابه‌جایی پین تکراری به انتها (منطق مسیر /pins)', () => {
  const MAX = 10; let list = [];
  const pin = (id) => { list = list.filter((x) => x !== id); list.push(id); while (list.length > MAX) list.shift(); };
  Array.from({ length: 12 }, (_, i) => String(i)).forEach(pin);
  assert.equal(list.length, 10); assert.equal(list[0], '2'); assert.equal(list.at(-1), '11');
  pin('5'); assert.equal(list.at(-1), '5');
});

test('botMedia.looksLikeImage: امضای واقعی JPEG/PNG/GIF/WEBP؛ HTML/SVG/متن/خالی رد', () => {
  const { looksLikeImage } = require('../src/utils/botMedia');
  const pad = (hex) => Buffer.from(hex.padEnd(24, '0'), 'hex');
  assert.equal(looksLikeImage(pad('ffd8ffe0')), true);
  assert.equal(looksLikeImage(pad('89504e470d0a1a0a')), true);
  assert.equal(looksLikeImage(Buffer.from('GIF89a000000')), true);
  assert.equal(looksLikeImage(Buffer.from('GIF87a000000')), true);
  assert.equal(looksLikeImage(Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP')])), true);
  assert.equal(looksLikeImage(Buffer.from('<html><script>alert(1)</script>')), false);
  assert.equal(looksLikeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), false);
  assert.equal(looksLikeImage(Buffer.from('plain text file!!')), false);
  assert.equal(looksLikeImage(Buffer.alloc(4)), false);
  assert.equal(looksLikeImage(null), false);
});

test('botMedia.allowBotUpload: سقف ساعتی هر ربات، جدا برای هر ربات، و آزاد شدن بعد از پنجره', () => {
  const { allowBotUpload, MAX_PER_WINDOW } = require('../src/utils/botMedia');
  const now = Date.now();
  for (let i = 0; i < MAX_PER_WINDOW; i++) assert.equal(allowBotUpload('botA', now), true);
  assert.equal(allowBotUpload('botA', now), false, 'بعد از سقف باید رد بشه');
  assert.equal(allowBotUpload('botB', now), true, 'ربات دیگه تحت‌تأثیر نیست');
  assert.equal(allowBotUpload('botA', now + 61 * 60 * 1000), true, 'بعد از یک ساعت دوباره آزاد');
});

test('sanitizeQuickReplies: پاک‌سازی، یکتا، سقف، کاراکتر مجاز', () => {
  const { sanitizeQuickReplies, MAX_QUICK_REPLIES } = require('../src/utils/quickReplies');
  assert.equal(sanitizeQuickReplies('x'), null);
  assert.equal(sanitizeQuickReplies(null), null);
  assert.deepEqual(sanitizeQuickReplies([{ shortcut: '/Hello!!', text: '  Hi there \r\n ok ' }]), [{ shortcut: 'hello', text: 'Hi there \n ok' }]);
  assert.deepEqual(sanitizeQuickReplies([{ shortcut: 'سلام', text: 'درود' }]), [{ shortcut: 'سلام', text: 'درود' }], 'حرف فارسی مجازه');
  assert.deepEqual(sanitizeQuickReplies([{ shortcut: 'a', text: '1' }, { shortcut: 'A', text: '2' }, { shortcut: '/a', text: '3' }]), [{ shortcut: 'a', text: '1' }], 'تکراری (بعد از نرمال‌سازی) حذف');
  assert.deepEqual(sanitizeQuickReplies([{ shortcut: '', text: 'x' }, { shortcut: 'b', text: '   ' }, null, 5, { shortcut: '!!!', text: 'x' }]), [], 'خالی/بی‌کاراکتر مجاز رد');
  const long = sanitizeQuickReplies([{ shortcut: 'x'.repeat(50), text: 'y'.repeat(900) }])[0];
  assert.equal(long.shortcut.length, 20); assert.equal(long.text.length, 500);
  const many = sanitizeQuickReplies(Array.from({ length: 60 }, (_, i) => ({ shortcut: `s${i}`, text: 't' })));
  assert.equal(many.length, MAX_QUICK_REPLIES);
  assert.deepEqual(sanitizeQuickReplies([{ shortcut: { toString: () => 'evil' }, text: { a: 1 } }, { shortcut: 5, text: 'x' }, { shortcut: 'ok', text: 7 }]), [], 'فیلد غیررشته‌ای رد می‌شود');
});

test('sanitizeTags: ≤۵، ≤۲۰ کاراکتر، یکتا، حرف کوچک، #، جداکننده‌ها، فارسی', () => {
  const { sanitizeTags } = require('../src/utils/messageTags');
  assert.deepEqual(sanitizeTags('work ideas'), ['work', 'ideas']);
  assert.deepEqual(sanitizeTags('#Work, ideas،کار'), ['work', 'ideas', 'کار']);
  assert.deepEqual(sanitizeTags(['a', 'A', '#a', 'b']), ['a', 'b'], 'یکتا بعد از نرمال‌سازی');
  assert.equal(sanitizeTags('1 2 3 4 5 6 7').length, 5);
  assert.equal(sanitizeTags(['x'.repeat(50)])[0].length, 20);
  assert.deepEqual(sanitizeTags('   '), []);
  assert.deepEqual(sanitizeTags(['<b>', '!!!', null, {}]), ['b'], 'کاراکتر غیرمجاز حذف می‌شود');
  assert.equal(sanitizeTags(5), null);
  assert.equal(sanitizeTags({}), null);
});

test('adminGuards: ناظر فقط روی کاربر عادی؛ ادمین روی همه؛ clampNumber', () => {
  const { canActOn, clampNumber } = require('../src/utils/adminGuards');
  assert.equal(canActOn('admin', 'admin'), true);
  assert.equal(canActOn('admin', 'moderator'), true);
  assert.equal(canActOn('admin', 'user'), true);
  assert.equal(canActOn('moderator', 'user'), true);
  assert.equal(canActOn('moderator', undefined), true, 'نقش ثبت‌نشده = user');
  assert.equal(canActOn('moderator', 'admin'), false, 'ناظر نباید روی ادمین عمل کند');
  assert.equal(canActOn('moderator', 'moderator'), false);
  assert.equal(canActOn('user', 'user'), false, 'کاربر عادی هیچ‌چیز');
  assert.equal(canActOn(undefined, 'user'), false);
  assert.equal(clampNumber('5', 1, 10, 3), 5);
  assert.equal(clampNumber(-4, 0, 10, 3), 0);
  assert.equal(clampNumber(1e12, 0, 3650, 3), 3650);
  assert.equal(clampNumber('abc', 0, 10, 7), 7);
  assert.equal(clampNumber(undefined, 0, 10, 7), 7);
  assert.equal(clampNumber(Infinity, 0, 10, 7), 7);
});

test('moderatorMayViewChat: ادمین همیشه؛ ناظر بسته به تنظیم (all/reported)؛ بقیه هیچ‌وقت', () => {
  const { moderatorMayViewChat } = require('../src/utils/adminGuards');
  const base = { chatId: 'c1', openReportedChatIds: ['c2', 'c3'] };
  assert.equal(moderatorMayViewChat({ ...base, role: 'admin', access: 'reported' }), true);
  assert.equal(moderatorMayViewChat({ ...base, role: 'moderator', access: 'all' }), true, 'پیش‌فرض: رفتار قبلی');
  assert.equal(moderatorMayViewChat({ ...base, role: 'moderator', access: undefined }), true);
  assert.equal(moderatorMayViewChat({ ...base, role: 'moderator', access: 'reported' }), false, 'چت بدون گزارش باز');
  assert.equal(moderatorMayViewChat({ ...base, chatId: 'c2', role: 'moderator', access: 'reported' }), true, 'چت دارای گزارش باز');
  assert.equal(moderatorMayViewChat({ chatId: { toString: () => 'c3' }, openReportedChatIds: ['c3'], role: 'moderator', access: 'reported' }), true, 'مقایسه‌ی ObjectId با رشته');
  assert.equal(moderatorMayViewChat({ ...base, role: 'user', access: 'all' }), false);
  assert.equal(moderatorMayViewChat({ ...base, role: undefined, access: 'all' }), false);
});

test('sanitizeTopic: عنوان الزامی ≤۳۰، ایموجی ≤۸ بدون فاصله، ورودی غیررشته رد', () => {
  const { sanitizeTopic, MAX_TOPICS } = require('../src/utils/topics');
  assert.deepEqual(sanitizeTopic({ title: '  Design   team ', emoji: '🎨' }), { title: 'Design team', emoji: '🎨' });
  assert.deepEqual(sanitizeTopic({ title: 'x'.repeat(80), emoji: ' 🎨 🎨 ' }), { title: 'x'.repeat(30), emoji: '🎨🎨' });
  assert.deepEqual(sanitizeTopic({ title: 'A\nB\tC' }), { title: 'A B C', emoji: '' });
  assert.equal(sanitizeTopic({ title: '   ' }), null);
  assert.equal(sanitizeTopic({ title: 5, emoji: 'x' }), null);
  assert.equal(sanitizeTopic({ title: { a: 1 } }), null);
  assert.equal(sanitizeTopic(null), null);
  assert.equal(sanitizeTopic('x'), null);
  assert.equal(MAX_TOPICS, 20);
});

test('Message.topic و Chat.topics: اسکیما معتبر؛ topic پیش‌فرض ندارد', () => {
  const mongoose = require('mongoose');
  const Chat = require('../src/models/Chat');
  const Message = require('../src/models/Message');
  const m = new Message({ chat: new mongoose.Types.ObjectId(), sender: new mongoose.Types.ObjectId(), type: 'text' }).toObject();
  assert.equal('topic' in m, false);
  const c = new Chat({ type: 'group', title: 'g', members: [], topics: [{ title: 'T', emoji: '🎨' }] });
  assert.equal(c.validateSync(), undefined);
  assert.equal(c.topics.length, 1);
  assert.ok(c.topics[0]._id, 'هر تاپیک شناسه‌ی خودش را دارد');
});

test('anonymizeChannelSender: فقط کانالِ بدون امضا؛ _id می‌ماند؛ گروه/کانالِ امضادار/sender غیرشیء دست‌نخورده', () => {
  const { anonymizeChannelSender } = require('../src/utils/channelPrivacy');
  const mk = () => ({ _id: 'm', sender: { _id: 'u1', displayName: 'Ali', username: 'ali', avatarUrl: 'http://x/a.png', isBot: false } });
  const ch = { type: 'channel', signMessages: false, title: 'News', avatarUrl: 'http://x/c.png' };
  const out = anonymizeChannelSender(ch, mk());
  assert.deepEqual(out.sender, { _id: 'u1', displayName: 'News', username: '', avatarUrl: 'http://x/c.png', isBot: false });
  assert.equal(anonymizeChannelSender({ ...ch, signMessages: true }, mk()).sender.displayName, 'Ali', 'امضادار');
  assert.equal(anonymizeChannelSender({ type: 'group', signMessages: false, title: 'G' }, mk()).sender.displayName, 'Ali', 'گروه');
  assert.equal(anonymizeChannelSender(ch, { sender: 'u1' }).sender, 'u1', 'sender پاپیولیت‌نشده');
  assert.equal(anonymizeChannelSender(ch, { sender: ['x'] }).sender[0], 'x');
  assert.equal(anonymizeChannelSender(ch, null), null);
  assert.equal(anonymizeChannelSender(null, mk()).sender.displayName, 'Ali');
  const original = mk(); anonymizeChannelSender(ch, original);
  assert.equal(original.sender._id, 'u1');
});

test('توکن موقتِ 2FA نباید به‌عنوان توکن دسترسی پذیرفته شود + ابطال با tokenVersion (میدل‌ویر واقعی با User ساختگی)', async () => {
  const jwt = require('jsonwebtoken');
  const User = require('../src/models/User');
  const { verifyAccessToken, isTokenCurrent } = require('../src/utils/tokens');
  const { requireAuth } = require('../src/middleware/auth');

  const normal = jwt.sign({ id: 'u1', role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const pending = jwt.sign({ id: 'u1', twoFactorPending: true }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const forged = jwt.sign({ id: 'u1' }, 'another-secret', { expiresIn: '1h' });
  const expired = jwt.sign({ id: 'u1' }, process.env.JWT_SECRET, { expiresIn: -10 });
  assert.equal(verifyAccessToken(normal).id, 'u1');
  assert.throws(() => verifyAccessToken(pending), /two-factor/);
  assert.throws(() => verifyAccessToken(forged));
  assert.throws(() => verifyAccessToken(expired));

  assert.equal(isTokenCurrent({}, { tokenVersion: 5 }), true, 'بدون tv: تحت‌تأثیر نیست');
  assert.equal(isTokenCurrent({ tv: 0 }, { tokenVersion: 0 }), true);
  assert.equal(isTokenCurrent({ tv: 0 }, {}), true, 'کاربر بدون فیلد = ۰');
  assert.equal(isTokenCurrent({ tv: 0 }, { tokenVersion: 1 }), false, 'بعد از ابطال');

  // میدل‌ویر واقعی؛ فقط User.findById ساختگی است
  const original = User.findById;
  const run = async (token, user) => {
    User.findById = async () => user;
    const req = { headers: { authorization: `Bearer ${token}` } };
    const out = { status: null, nextCalled: false };
    const res = { status(c) { out.status = c; return this; }, json() { return this; } };
    await requireAuth(req, res, () => { out.nextCalled = true; });
    return out;
  };
  try {
    const user = { _id: 'u1', status: 'active', tokenVersion: 0 };
    assert.equal((await run(normal, user)).nextCalled, true, 'توکن عادی پذیرفته');
    const p = await run(pending, user);
    assert.equal(p.nextCalled, false, 'توکن موقتِ 2FA نباید عبور کند');
    assert.equal(p.status, 401);
    const adminTok = jwt.sign({ id: 'u1', role: 'admin', tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    assert.equal((await run(adminTok, { ...user, tokenVersion: 0 })).nextCalled, true);
    const revoked = await run(adminTok, { ...user, tokenVersion: 1 });
    assert.equal(revoked.nextCalled, false, 'توکن ابطال‌شده');
    assert.equal(revoked.status, 401);
    assert.equal((await run(normal, { ...user, status: 'deleted' })).status, 401, 'حساب حذف‌شده');
  } finally { User.findById = original; }
});
