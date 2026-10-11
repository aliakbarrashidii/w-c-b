const express = require('express');
const Chat = require('../models/Chat');
const mongoose = require('mongoose');
const { anonymizeChannelSender } = require('../utils/channelPrivacy');
const { clampNumber } = require('../utils/adminGuards');
const rateLimit = require('express-rate-limit');
const Message = require('../models/Message');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const { decryptText } = require('../utils/crypto');
const { purgeChats, purgeIfAbandoned } = require('../utils/dataCleanup');

const { guard } = require('../utils/restrictions');
const rights = require('../utils/chatRights');
const { humanIds } = require('../utils/botEngine');
const ChatAdminLog = require('../models/ChatAdminLog');
const router = express.Router();

function myMembership(chat, userId) {
  return chat.members.find((m) => m.user.toString() === userId.toString() || m.user._id?.toString() === userId.toString());
}

// لیست چت‌های من (خصوصی و گروهی)، مرتب بر اساس آخرین فعالیت
router.get('/', requireAuth, async (req, res) => {
  const { archived } = req.query;

  // مطمئن می‌شیم چت «پیام‌های ذخیره‌شده» همیشه وجود داره (فقط یه‌بار، برای هر کاربر)
  await Chat.findOneAndUpdate(
    { type: 'saved', 'members.user': req.user._id },
    { $setOnInsert: { type: 'saved', members: [{ user: req.user._id, role: 'owner' }] } },
    { upsert: true }
  );

  const chats = await Chat.find({ 'members.user': req.user._id })
    .sort({ lastActivityAt: -1 })
    .populate('members.user', 'username displayName avatarUrl isOnline lastSeen isBot')
    .populate('lastMessage');

  const filtered = chats.filter((c) => {
    const me = myMembership(c, req.user._id);
    const isArchived = !!me?.archived;
    return archived === 'true' ? isArchived : !isArchived;
  });

  const decrypted = await Promise.all(
    filtered.map(async (c) => {
      const obj = c.toObject();
      if (obj.lastMessage && obj.type !== 'secret') obj.lastMessage.content = decryptText(obj.lastMessage.content);
      const me = myMembership(c, req.user._id);
      obj.myState = { muted: !!(me?.mutedUntil && me.mutedUntil > new Date()), archived: !!me?.archived, pinnedInList: !!me?.pinnedInList, markedUnread: !!me?.markedUnread, wallpaper: me?.wallpaper || null, role: me?.role || 'member' };
      obj.unreadCount = await Message.countDocuments({
        chat: c._id,
        sender: { $ne: req.user._id },
        'readBy.user': { $ne: req.user._id },
        deletedForEveryone: { $ne: true },
        ...(me?.clearedAt ? { createdAt: { $gt: me.clearedAt } } : {}),
      });
      return obj;
    })
  );

  decrypted.sort(
    (a, b) =>
      (b.type === 'saved') - (a.type === 'saved') ||
      (b.myState.pinnedInList - a.myState.pinnedInList) ||
      (new Date(b.lastActivityAt) - new Date(a.lastActivityAt))
  );
  res.json(decrypted);
});


// جمع پیام‌های خوانده‌نشده‌ی کل حساب (برای نشان کنار حساب‌های دیگر تو تعویض حساب).
// چت‌های میوت‌شده تو `unmuted` حساب نمی‌شن (مثل تلگرام)؛ `total` همه‌شونه. فقط تعداد برمی‌گردونه، نه محتوا.
router.get('/unread-total', requireAuth, async (req, res) => {
  const chats = await Chat.find({ 'members.user': req.user._id }).select('members');
  let total = 0;
  let unmuted = 0;
  const now = new Date();
  for (const c of chats) {
    const me = myMembership(c, req.user._id);
    const n = await Message.countDocuments({ chat: c._id, sender: { $ne: req.user._id }, 'readBy.user': { $ne: req.user._id }, deletedForEveryone: { $ne: true }, ...(me?.clearedAt ? { createdAt: { $gt: me.clearedAt } } : {}) });
    // چتِ «علامت‌خورده به‌عنوان خوانده‌نشده» (بدون پیام جدید) هم یک واحد حساب می‌شه - مثل تلگرام
    const count = n === 0 && me?.markedUnread ? 1 : n;
    total += count;
    if (!(me?.mutedUntil && me.mutedUntil > now)) unmuted += count;
  }
  res.json({ total, unmuted });
});

// خلاصه‌ی آرشیو برای ردیفِ «آرشیو» بالای لیست چت‌ها: تعداد چت و مجموع خوانده‌نشده‌ها (فقط از چت‌های میوت‌نشده، مثل تلگرام)
router.get('/archive-summary', requireAuth, async (req, res) => {
  const chats = await Chat.find({ members: { $elemMatch: { user: req.user._id, archived: true } } }).select('members');
  let unread = 0;
  for (const c of chats) {
    const me = myMembership(c, req.user._id);
    unread += await Message.countDocuments({ chat: c._id, sender: { $ne: req.user._id }, 'readBy.user': { $ne: req.user._id }, deletedForEveryone: { $ne: true }, ...(me?.clearedAt ? { createdAt: { $gt: me.clearedAt } } : {}) });
  }
  res.json({ count: chats.length, unread });
});

// آرشیو / آنآرشیو
router.post('/:chatId/archive', requireAuth, async (req, res) => {
  const { archived } = req.body;
  const chat = await Chat.findById(req.params.chatId);
  const me = myMembership(chat, req.user._id);
  if (!me) return res.status(403).json({ error: 'شما عضو این چت نیستید' });
  me.archived = !!archived;
  await chat.save();
  res.json({ ok: true });
});

// میوت / آنمیوت
router.post('/:chatId/mute', requireAuth, async (req, res) => {
  const { muted, hours } = req.body;
  const chat = await Chat.findById(req.params.chatId);
  const me = myMembership(chat, req.user._id);
  if (!me) return res.status(403).json({ error: 'شما عضو این چت نیستید' });
  me.mutedUntil = muted ? new Date(Date.now() + (hours || 24 * 365) * 3600 * 1000) : null;
  await chat.save();
  res.json({ ok: true, mutedUntil: me.mutedUntil });
});

// پس‌زمینه‌ی اختصاصی این چت (فقط برای خودم — طرف مقابل چیزی نمی‌بینه)
router.post('/:chatId/wallpaper', requireAuth, async (req, res) => {
  const { wallpaper } = req.body; // رنگ هگز، یا null برای برگشت به پیش‌فرض تم
  const chat = await Chat.findById(req.params.chatId);
  const me = myMembership(chat, req.user._id);
  if (!me) return res.status(403).json({ error: 'شما عضو این چت نیستید' });
  me.wallpaper = wallpaper || null;
  await chat.save();
  res.json({ ok: true });
});

// پین‌کردن چت در بالای لیست
router.post('/:chatId/pin-list', requireAuth, async (req, res) => {
  const { pinned } = req.body;
  const chat = await Chat.findById(req.params.chatId);
  const me = myMembership(chat, req.user._id);
  if (!me) return res.status(403).json({ error: 'شما عضو این چت نیستید' });
  me.pinnedInList = !!pinned;
  await chat.save();
  res.json({ ok: true });
});

// علامت‌گذاری همه‌ی پیام‌های چت به‌عنوان خوانده‌شده
router.post('/:chatId/mark-read', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId);
  if (!myMembership(chat, req.user._id)) return res.status(403).json({ error: 'شما عضو این چت نیستید' });
  await Message.updateMany(
    { chat: chat._id, sender: { $ne: req.user._id }, 'readBy.user': { $ne: req.user._id } },
    { $addToSet: { readBy: { user: req.user._id, readAt: new Date() } } }
  );
  // خوانده‌شدنِ چت، علامت دستیِ «خوانده‌نشده» رو هم پاک می‌کنه
  const me = myMembership(chat, req.user._id);
  if (me?.markedUnread) { me.markedUnread = false; await chat.save(); }
  res.json({ ok: true });
});

// علامت‌گذاری دستی چت به‌عنوان خوانده‌نشده (برای «بعداً جواب می‌دم»)؛ پیام‌ها دست‌نخورده می‌مونن
router.post('/:chatId/mark-unread', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId);
  const me = chat && myMembership(chat, req.user._id);
  if (!me) return res.status(403).json({ error: 'عضو این چت نیستید' });
  me.markedUnread = req.body?.value !== false;
  await chat.save();
  res.json({ ok: true, markedUnread: me.markedUnread });
});

// پاک کردن تاریخچه (فقط برای خودم — پیام‌های قبل از الان دیگه تو این چت برام نمایش داده نمی‌شن)
router.post('/:chatId/clear-history', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId);
  const me = myMembership(chat, req.user._id);
  if (!me) return res.status(403).json({ error: 'شما عضو این چت نیستید' });
  me.clearedAt = new Date();
  await chat.save();
  // اگه همه‌ی اعضای چتِ خصوصی تاریخچه رو پاک کردن و تنظیم شخصی‌ای نمونده، خودِ چت هم از DB پاک می‌شه
  await purgeIfAbandoned(chat).catch((e) => console.error('[cleanup] purgeIfAbandoned:', e.message));
  res.json({ ok: true });
});

// شروع چت خصوصی با یک کاربر (اگر از قبل وجود داشته باشد همان را برمی‌گرداند)
router.post('/private', requireAuth, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'شناسه کاربر الزامی است' });

  const other = await User.findById(userId);
  if (!other) return res.status(404).json({ error: 'کاربر یافت نشد' });

  let chat = await Chat.findOne({
    type: 'private',
    'members.user': { $all: [req.user._id, other._id] },
    $expr: { $eq: [{ $size: '$members' }, 2] },
  });
  if (!chat) {
    const blocked = await guard(req.user, 'new_chats');
    if (blocked) return res.status(403).json({ error: blocked });
  }

  if (!chat) {
    chat = await Chat.create({
      type: 'private',
      members: [{ user: req.user._id }, { user: other._id }],
    });
  }
  res.json(chat);
});

// چت «پیام‌های ذخیره‌شده» شخصی (اگر وجود نداشته باشد می‌سازد)
// چت مخفی: پیام‌ها سمت کلاینت با یه عبارت رمز مشترک رمزنگاری می‌شن، سرور اصلاً کلید رو نمی‌بینه
// و متن رمزنگاری‌شده رو دست‌نخورده رد و بدل می‌کنه (بدون رمزنگاری اضافه‌ی خودِ سرور)
router.post('/secret', requireAuth, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'شناسه کاربر الزامی است' });

  const other = await User.findById(userId);
  if (!other) return res.status(404).json({ error: 'کاربر یافت نشد' });

  let chat = await Chat.findOne({
    type: 'secret',
    'members.user': { $all: [req.user._id, other._id] },
    $expr: { $eq: [{ $size: '$members' }, 2] },
  });

  if (!chat) {
    chat = await Chat.create({ type: 'secret', members: [{ user: req.user._id }, { user: other._id }] });
  }
  res.json(chat);
});

// ثبت/تایید عبارت رمز چت مخفی — فقط هش تایید ذخیره می‌شه، نه خودِ عبارت یا کلید
// حدس‌زدنِ رمزِ قفلِ چت مخفی: حداکثر ۱۰ تلاش در ۱۵ دقیقه برای هر (کاربر، چت)
const passphraseLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.user?._id}:${req.params.chatId}`,
  message: { error: 'تلاش‌های زیاد؛ چند دقیقه‌ی دیگر دوباره امتحان کنید' },
});
router.post('/:chatId/verify-passphrase', requireAuth, passphraseLimiter, async (req, res) => {
  const { hash } = req.body || {};
  const chat = await Chat.findById(req.params.chatId);
  if (!chat || chat.type !== 'secret') return res.status(400).json({ error: 'این چت مخفی نیست' });
  // فقط اعضای همین چت: قبلاً هر کاربرِ لاگین‌شده می‌تونست رمزِ قفلِ چتِ مخفیِ دیگران رو (اگه هنوز تنظیم نشده بود) خودش تنظیم کنه،
  // یا با حدس زدن «hash» ازش اوراکل بسازه
  if (!myMembership(chat, req.user._id)) return res.status(403).json({ error: 'عضو این چت نیستید' });
  if (typeof hash !== 'string' || !hash || hash.length > 256) return res.status(400).json({ error: 'مقدار نامعتبر است' });

  if (!chat.secretSettings.passphraseHash) {
    chat.secretSettings.passphraseHash = hash;
    await chat.save();
    return res.json({ match: true, first: true });
  }
  // مقایسه‌ی زمان‌ثابت (جلوگیری از timing attack)
  const a = Buffer.from(chat.secretSettings.passphraseHash);
  const b = Buffer.from(hash);
  const match = a.length === b.length && require('crypto').timingSafeEqual(a, b);
  res.json({ match, first: false });
});



// حذف خودکار پیام‌های چت (۰ / ۱ روز / ۱ هفته / ۱ ماه). فقط روی پیام‌های بعد از تنظیم اثر داره (مثل تلگرام).
// خصوصی: هر دو عضو می‌تونن؛ گروه/کانال: مالک یا ادمینِ دارای «تغییر اطلاعات». چت مخفی تایمر خودش رو داره.
const AUTO_DELETE_OPTIONS = [0, 86400, 604800, 2592000];
router.post('/:chatId/auto-delete', requireAuth, async (req, res) => {
  const seconds = Number(req.body?.seconds) || 0;
  if (!AUTO_DELETE_OPTIONS.includes(seconds)) return res.status(400).json({ error: 'مقدار نامعتبر است' });
  const chat = await Chat.findById(req.params.chatId);
  const me = chat && myMembership(chat, req.user._id);
  if (!me) return res.status(403).json({ error: 'عضو این چت نیستید' });
  if (chat.type === 'secret' || chat.type === 'saved') return res.status(400).json({ error: 'برای این نوع چت در دسترس نیست' });
  if (['group', 'channel'].includes(chat.type) && !rights.can(chat, req.user._id, 'changeInfo')) {
    return res.status(403).json({ error: 'اجازه‌ی تغییر اطلاعات را ندارید' });
  }
  chat.autoDeleteSec = seconds;
  await chat.save();
  req.app.get('io')?.to(`chat:${chat._id}`).emit('chat:autoDelete', { chatId: chat._id, seconds });
  res.json({ ok: true, autoDeleteSec: seconds });
});

// تنظیم زمان خودتخریب پیام‌های چت مخفی
router.post('/:chatId/secret-ttl', requireAuth, async (req, res) => {
  const { ttlSeconds } = req.body || {};
  const chat = await Chat.findById(req.params.chatId);
  if (!chat || chat.type !== 'secret') return res.status(400).json({ error: 'این چت مخفی نیست' });
  // قبلاً هر کاربری می‌تونست تایمر چتِ مخفیِ دیگران رو مثلاً روی ۱ ثانیه بذاره و پیام‌هاشون رو نابود کنه
  if (!myMembership(chat, req.user._id)) return res.status(403).json({ error: 'عضو این چت نیستید' });
  const ttl = Math.floor(Number(ttlSeconds) || 0);
  if (ttl < 0 || ttl > 30 * 86400) return res.status(400).json({ error: 'مقدار نامعتبر است' });
  chat.secretSettings.ttlSeconds = ttl;
  await chat.save();
  res.json({ ok: true, ttlSeconds: chat.secretSettings.ttlSeconds });
});



router.get('/saved', requireAuth, async (req, res) => {
  let chat = await Chat.findOne({ type: 'saved', 'members.user': req.user._id });
  if (!chat) {
    chat = await Chat.create({ type: 'saved', members: [{ user: req.user._id, role: 'owner' }] });
  }
  res.json(chat);
});

// پین/آنپین پیام در یک چت
const MAX_PINS = 10;

// اعتبارسنجی پیام برای پین: باید تو همین چت باشه و حذف نشده باشه (قبلاً هر messageId دلخواه، حتی از چت دیگه، قبول می‌شد و
// GET /chats/:id محتوای رمزگشایی‌شده‌ی اون پیام رو به همه‌ی اعضای این چت نشون می‌داد - نشت اطلاعات)
async function validPinTarget(chat, messageId) {
  if (!mongoose.isValidObjectId(messageId)) return null;
  return Message.findOne({ _id: messageId, chat: chat._id, deletedForEveryone: { $ne: true } }).select('_id');
}
function syncLegacyPin(chat) {
  const list = chat.pinnedMessages || [];
  chat.pinnedMessage = list.length ? list[list.length - 1] : null; // نسخه‌های قدیمی اپ فقط آخرین پین رو می‌شناسن
}

// پین/برداشتن پین یک پیام (چندتایی). body: { messageId, pinned: boolean }
router.post('/:chatId/pins', requireAuth, async (req, res) => {
  const { messageId, pinned } = req.body || {};
  const chat = await Chat.findById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: 'چت پیدا نشد' });
  const isMember = chat.members.some((m) => m.user.toString() === req.user._id.toString());
  if (!isMember) return res.status(403).json({ error: 'شما عضو این چت نیستید' });
  if (['group', 'channel'].includes(chat.type) && !rights.can(chat, req.user._id, 'pinMessages') && !(chat.type === 'group' && rights.memberAllowed(chat, req.user._id, 'pinMessages') && (chat.permissions || {}).pinMessages === true)) {
    return res.status(403).json({ error: 'اجازه‌ی پین‌کردن رو نداری' });
  }
  const msg = await validPinTarget(chat, messageId);
  if (!msg) return res.status(404).json({ error: 'پیام پیدا نشد' });
  const id = String(msg._id);
  const list = (chat.pinnedMessages || []).map(String).filter((x) => x !== id);
  if (pinned !== false) {
    list.push(id);
    while (list.length > MAX_PINS) list.shift(); // قدیمی‌ترین پین کنار می‌ره
  }
  chat.pinnedMessages = list;
  syncLegacyPin(chat);
  rights.logAction(chat._id, req.user._id, pinned !== false ? 'pin' : 'unpin');
  await chat.save();
  req.app.get('io')?.to(`chat:${chat._id}`).emit('chat:pins', { chatId: chat._id });
  res.json({ ok: true, pinnedMessages: chat.pinnedMessages });
});

// سازگاری با نسخه‌های قدیمی اپ: messageId → اضافه به پین‌ها | null → برداشتن همه
router.post('/:chatId/pin', requireAuth, async (req, res) => {
  const { messageId } = req.body || {};
  const chat = await Chat.findById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: 'چت پیدا نشد' });
  const isMember = chat.members.some((m) => m.user.toString() === req.user._id.toString());
  if (!isMember) return res.status(403).json({ error: 'شما عضو این چت نیستید' });
  if (['group', 'channel'].includes(chat.type) && !rights.can(chat, req.user._id, 'pinMessages') && !(chat.type === 'group' && rights.memberAllowed(chat, req.user._id, 'pinMessages') && (chat.permissions || {}).pinMessages === true)) {
    return res.status(403).json({ error: 'اجازه‌ی پین‌کردن رو نداری' });
  }
  if (messageId) {
    const msg = await validPinTarget(chat, messageId);
    if (!msg) return res.status(404).json({ error: 'پیام پیدا نشد' });
    chat.pinnedMessages = [...(chat.pinnedMessages || []).map(String).filter((x) => x !== String(msg._id)), String(msg._id)].slice(-MAX_PINS);
  } else {
    chat.pinnedMessages = [];
  }
  syncLegacyPin(chat);
  rights.logAction(chat._id, req.user._id, messageId ? 'pin' : 'unpin');
  await chat.save();
  req.app.get('io')?.to(`chat:${chat._id}`).emit('chat:pins', { chatId: chat._id });
  res.json({ ok: true, pinnedMessage: chat.pinnedMessage });
});

// ساخت گروه
router.post('/group', requireAuth, async (req, res) => {
  const { title, description, memberIds = [] } = req.body;
  if (!title) return res.status(400).json({ error: 'عنوان گروه الزامی است' });
  const blocked = await guard(req.user, 'create_groups');
  if (blocked) return res.status(403).json({ error: blocked });

  const members = [{ user: req.user._id, role: 'owner' }, ...memberIds.map((id) => ({ user: id, role: 'member' }))];

  const chat = await Chat.create({ type: 'group', title, description, members });
  res.status(201).json(chat);
});

// کانال: فقط owner/admin می‌تونن پیام بفرستن، بقیه فقط عضو/خواننده‌ن (چک دقیقش تو سوکت message:send انجام می‌شه)
router.post('/channel', requireAuth, async (req, res) => {
  const { title, description, memberIds = [] } = req.body;
  if (!title) return res.status(400).json({ error: 'عنوان کانال الزامی است' });
  const blocked = await guard(req.user, 'create_groups');
  if (blocked) return res.status(403).json({ error: blocked });

  const members = [{ user: req.user._id, role: 'owner' }, ...memberIds.map((id) => ({ user: id, role: 'member' }))];

  const chat = await Chat.create({ type: 'channel', title, description, members });
  res.status(201).json(chat);
});

// افزودن عضو به گروه - فقط owner/admin. بعد از موفقیت، کلاینت‌های عضوِ آنلاین یه رویداد می‌گیرن
// تا اگه سندرکیِ گروهی دارن، برای عضو تازه هم توزیعش کنن (mobile-app/src/crypto/groupSession.js)
router.post('/:chatId/members', requireAuth, async (req, res) => {
  { const blocked = await guard(req.user, 'join_groups'); if (blocked) return res.status(403).json({ error: blocked }); }
  const { userIds = [] } = req.body;
  const chat = await Chat.findById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: 'چت یافت نشد' });
  const me = chat.members.find((m) => m.user.toString() === req.user._id.toString());
  const mayInvite = rights.can(chat, req.user._id, 'inviteUsers') || (chat.type === 'group' && me && rights.memberAllowed(chat, req.user._id, 'addMembers') && (chat.permissions || {}).addMembers === true);
  if (!me || !mayInvite) return res.status(403).json({ error: 'اجازه‌ی این کار رو نداری' });

  const existingIds = new Set(chat.members.map((m) => m.user.toString()));
  const bannedIds = new Set((chat.banned || []).map((b) => b.toString()));
  const toAdd = userIds.filter((id) => !existingIds.has(id) && !bannedIds.has(String(id)));
  if (!toAdd.length) return res.json(chat);
  chat.members.push(...toAdd.map((id) => ({ user: id, role: 'member' })));
  await chat.save();
  toAdd.forEach((uid) => rights.logAction(chat._id, req.user._id, 'add_member', uid));

  const io = req.app.get('io');
  const memberIds = await humanIds(chat.members.map((m) => m.user.toString()));
  const addedHumans = await humanIds(toAdd);
  io?.to(`chat:${chat._id}`).emit('group:membersChanged', { chatId: chat._id, memberIds, addedUserIds: addedHumans, reason: 'added' });
  toAdd.forEach((uid) => io?.to(`user:${uid}`).emit('group:membersChanged', { chatId: chat._id, memberIds, addedUserIds: addedHumans, reason: 'added' }));

  res.json(chat);
});

// پیوستن با لینک دعوت (قبل از مسیرهای /:chatId تعریف شده)
// منطق مشترکِ پیوستن (لینک دعوت یا نام کاربری عمومی)
async function joinFlow(req, res, chat) {
  const blocked = await guard(req.user, 'join_groups');
  if (blocked) return res.status(403).json({ error: blocked });
  if (!chat) return res.status(404).json({ error: 'پیدا نشد یا لینک منقضی شده' });
  const already = chat.members.some((m) => m.user.toString() === req.user._id.toString());
  if ((chat.banned || []).some((b) => b.toString() === req.user._id.toString())) return res.status(403).json({ error: 'از این گروه محروم شده‌ای' });
  if (!already && chat.joinApproval) {
    if (!chat.joinRequests.some((r) => r.user.toString() === req.user._id.toString())) {
      chat.joinRequests.push({ user: req.user._id });
      await chat.save();
      req.app.get('io')?.to(`chat:${chat._id}`).emit('group:joinRequest', { chatId: chat._id });
    }
    return res.json({ pending: true, title: chat.title, chatId: chat._id });
  }
  if (!already) {
    chat.members.push({ user: req.user._id, role: 'member' });
    await chat.save();
    const io = req.app.get('io');
    const memberIds = await humanIds(chat.members.map((m) => m.user.toString()));
    const payload = { chatId: chat._id, memberIds, addedUserIds: [req.user._id.toString()], reason: 'added' };
    io?.to(`chat:${chat._id}`).emit('group:membersChanged', payload);
    io?.to(`user:${req.user._id}`).emit('group:membersChanged', payload);
  }
  return res.json({ chatId: chat._id, title: chat.title, avatarUrl: chat.avatarUrl, type: chat.type, alreadyMember: already });
}

router.post('/join/:code', requireAuth, async (req, res) => {
  joinFlow(req, res, await Chat.findOne({ inviteCode: req.params.code, type: { $in: ['group', 'channel'] } }));
});
router.post('/join-public/:username', requireAuth, async (req, res) => {
  joinFlow(req, res, await Chat.findOne({ publicUsername: req.params.username.toLowerCase().replace(/^@/, ''), type: { $in: ['group', 'channel'] } }));
});

// جستجوی عمومی: گروه/کانال‌های «عمومی» و ربات‌ها (کاربران عادی عمداً جستجوپذیر نیستن)
router.get('/public/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().replace(/^@/, '');
  if (q.length < 2) return res.json([]);
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const [chats, bots] = await Promise.all([
    Chat.find({ publicUsername: { $regex: `^${esc}` }, type: { $in: ['group', 'channel'] } }).limit(10).select('type title publicUsername avatarUrl description members'),
    User.find({ isBot: true, username: { $regex: `^${esc}` } }).limit(8).select('username displayName avatarUrl bio'),
  ]);
  res.json([
    ...chats.map((c) => ({ kind: c.type, id: c._id, title: c.title, username: c.publicUsername, avatarUrl: c.avatarUrl, description: c.description, memberCount: c.members.length })),
    ...bots.map((b) => ({ kind: 'bot', id: b._id, title: b.displayName, username: b.username, avatarUrl: b.avatarUrl, description: b.bio })),
  ]);
});

// ساخت/بازنشانی لینک دعوت (فقط ادمین/مالک). reset=true کد قبلی رو باطل می‌کنه
router.post('/:chatId/invite-link', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId);
  if (!chat || !['group', 'channel'].includes(chat.type)) return res.status(404).json({ error: 'گروه یافت نشد' });
  const me = chat.members.find((m) => m.user.toString() === req.user._id.toString());
  if (!me || !rights.can(chat, req.user._id, 'inviteUsers')) return res.status(403).json({ error: 'اجازه‌ی این کار رو نداری' });
  if (!chat.inviteCode || req.body.reset) {
    chat.inviteCode = require('crypto').randomBytes(9).toString('base64url');
    await chat.save();
  }
  res.json({ code: chat.inviteCode, link: `wizchat://join/${chat.inviteCode}` });
});

// ویرایش مشخصات گروه/کانال (فقط ادمین/مالک): عنوان، توضیح، آواتار، حالت آهسته
router.patch('/:chatId', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId);
  if (!chat || !['group', 'channel'].includes(chat.type)) return res.status(404).json({ error: 'گروه یافت نشد' });
  const me = chat.members.find((m) => m.user.toString() === req.user._id.toString());
  if (!me || !rights.can(chat, req.user._id, 'changeInfo')) return res.status(403).json({ error: 'اجازه‌ی این کار رو نداری' });
  const { title, description, avatarUrl, slowModeSec, permissions, joinApproval, publicUsername, signMessages, allowMemberTags } = req.body;
  if (publicUsername !== undefined) {
    // فقط مالک: عمومی‌کردن/برداشتن نام کاربری گروه یا کانال
    if (me.role !== 'owner') return res.status(403).json({ error: 'فقط مالک می‌تونه نام کاربری عمومی تعیین کنه' });
    const u = String(publicUsername || '').trim().toLowerCase().replace(/^@/, '');
    if (!u) chat.publicUsername = null;
    else {
      if (!/^[a-z][a-z0-9_]{4,31}$/.test(u)) return res.status(400).json({ error: 'نام کاربری باید ۵ تا ۳۲ حرف انگلیسی/عدد/_ باشه و با حرف شروع بشه' });
      if (await Chat.findOne({ publicUsername: u, _id: { $ne: chat._id } }) || await User.findOne({ username: u })) return res.status(409).json({ error: 'این نام کاربری قبلاً گرفته شده' });
      chat.publicUsername = u;
    }
  }
  if (permissions && typeof permissions === 'object') {
    chat.permissions = Object.fromEntries(rights.MEMBER_PERMS.map((k) => [k, permissions[k] !== false]));
    chat.markModified('permissions');
  }
  if (typeof joinApproval === 'boolean') chat.joinApproval = joinApproval;
  if (typeof title === 'string') { if (!title.trim()) return res.status(400).json({ error: 'عنوان نمی‌تونه خالی باشه' }); chat.title = title.trim().slice(0, 80); }
  if (typeof description === 'string') chat.description = description.trim().slice(0, 500);
  // آواتار فقط از آپلودهای خودمون یا خالی (قبلاً هر URL بیرونی: ردیابی IP همه‌ی اعضا هنگام باز کردن چت)
  if (typeof avatarUrl === 'string') {
    if (avatarUrl && !require('../utils/dataCleanup').uploadPathFromUrl(avatarUrl)) return res.status(400).json({ error: 'آواتار باید از فایل‌های آپلودشده باشد' });
    chat.avatarUrl = avatarUrl;
  }
  if (typeof signMessages === 'boolean' && chat.type === 'channel') chat.signMessages = signMessages;
  if (typeof allowMemberTags === 'boolean') chat.allowMemberTags = allowMemberTags;
  if (slowModeSec !== undefined && chat.type === 'group') chat.slowModeSec = Math.max(0, Math.min(Number(slowModeSec) || 0, 86400));
  await chat.save();
  rights.logAction(chat._id, req.user._id, 'update_info', null, Object.keys(req.body).join(','));
  req.app.get('io')?.to(`chat:${chat._id}`).emit('group:updated', { chatId: chat._id, title: chat.title, description: chat.description, avatarUrl: chat.avatarUrl, slowModeSec: chat.slowModeSec, permissions: chat.permissions, signMessages: chat.signMessages });
  res.json({ ok: true, title: chat.title, description: chat.description, avatarUrl: chat.avatarUrl, slowModeSec: chat.slowModeSec, publicUsername: chat.publicUsername, signMessages: chat.signMessages });
});

// تغییر نقش عضو (فقط مالک): admin | member
router.post('/:chatId/members/:userId/role', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: 'چت یافت نشد' });
  const me = chat.members.find((m) => m.user.toString() === req.user._id.toString());
  if (!me || !rights.can(chat, req.user._id, 'addAdmins')) return res.status(403).json({ error: 'اجازه‌ی تغییر نقش‌ها رو نداری' });
  const target = chat.members.find((m) => m.user.toString() === req.params.userId);
  if (!target || target.role === 'owner') return res.status(400).json({ error: 'عضو نامعتبر' });
  if (!['admin', 'member'].includes(req.body.role)) return res.status(400).json({ error: 'نقش نامعتبر' });
  if (target.role === 'admin' && me.role !== 'owner') return res.status(403).json({ error: 'فقط مالک می‌تونه ادمین‌ها رو تغییر بده' });
  target.role = req.body.role;
  if (req.body.role === 'admin') {
    const incoming = req.body.rights || {};
    // ادمین نمی‌تونه حقی بده که خودش نداره
    target.rights = Object.fromEntries(rights.ADMIN_RIGHTS.map((k) => [k, (me.role === 'owner' || rights.can(chat, req.user._id, k)) ? (incoming[k] ?? rights.DEFAULT_ADMIN_RIGHTS[k]) === true : false]));
  } else target.rights = undefined;
  await chat.save();
  rights.logAction(chat._id, req.user._id, req.body.role === 'admin' ? 'promote' : 'demote', target.user);
  req.app.get('io')?.to(`chat:${chat._id}`).emit('group:updated', { chatId: chat._id, rolesChanged: true });
  res.json({ ok: true });
});

// انتقال دستی مالکیت گروه/کانال به یکی از اعضا. فقط مالک؛ برای جلوگیری از سوءاستفاده از نشستِ باز، رمز عبور دوباره پرسیده می‌شه.


// ---- تاپیک‌های گروه: مالک یا ادمینِ «تغییر اطلاعات» می‌سازد/ویرایش/حذف می‌کند (فقط type=group) ----
async function topicsContext(req, res) {
  const chat = await Chat.findById(req.params.chatId);
  if (!chat || chat.type !== 'group') { res.status(404).json({ error: 'گروه پیدا نشد' }); return null; }
  if (!myMembership(chat, req.user._id) || !rights.can(chat, req.user._id, 'changeInfo')) { res.status(403).json({ error: 'اجازه‌ی مدیریت تاپیک‌ها را ندارید' }); return null; }
  return chat;
}
const emitTopics = (req, chat) => req.app.get('io')?.to(`chat:${chat._id}`).emit('group:updated', { chatId: chat._id, topics: chat.topics });

router.post('/:chatId/topics', requireAuth, async (req, res) => {
  const chat = await topicsContext(req, res); if (!chat) return;
  const { sanitizeTopic, MAX_TOPICS } = require('../utils/topics');
  const t = sanitizeTopic(req.body);
  if (!t) return res.status(400).json({ error: 'عنوان تاپیک الزامی است' });
  if (chat.topics.length >= MAX_TOPICS) return res.status(400).json({ error: `حداکثر ${MAX_TOPICS} تاپیک` });
  chat.topics.push(t);
  await chat.save();
  rights.logAction(chat._id, req.user._id, 'topic_add', null, t.title);
  emitTopics(req, chat);
  res.status(201).json({ ok: true, topics: chat.topics });
});

router.patch('/:chatId/topics/:topicId', requireAuth, async (req, res) => {
  const chat = await topicsContext(req, res); if (!chat) return;
  const topic = chat.topics.id(req.params.topicId);
  if (!topic) return res.status(404).json({ error: 'تاپیک پیدا نشد' });
  const t = require('../utils/topics').sanitizeTopic({ title: req.body?.title ?? topic.title, emoji: req.body?.emoji ?? topic.emoji });
  if (!t) return res.status(400).json({ error: 'عنوان تاپیک نامعتبر است' });
  topic.title = t.title; topic.emoji = t.emoji;
  await chat.save();
  emitTopics(req, chat);
  res.json({ ok: true, topics: chat.topics });
});

router.delete('/:chatId/topics/:topicId', requireAuth, async (req, res) => {
  const chat = await topicsContext(req, res); if (!chat) return;
  const topic = chat.topics.id(req.params.topicId);
  if (!topic) return res.status(404).json({ error: 'تاپیک پیدا نشد' });
  topic.deleteOne();
  await chat.save();
  // پیام‌های این تاپیک پاک نمی‌شن؛ برمی‌گردن به «عمومی»
  await Message.updateMany({ chat: chat._id, topic: req.params.topicId }, { $unset: { topic: '' } });
  rights.logAction(chat._id, req.user._id, 'topic_delete', null, topic.title);
  emitTopics(req, chat);
  res.json({ ok: true, topics: chat.topics });
});

// برچسب عضو: مالک یا ادمینِ دارای «تغییر اطلاعات». حداکثر ۱۶ کاراکتر؛ خالی = برداشتن. (مثل «عنوان ادمین» تلگرام ولی برای همه‌ی اعضا)
router.post('/:chatId/members/:userId/tag', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId);
  if (!chat || !['group', 'channel'].includes(chat.type)) return res.status(404).json({ error: 'گروه یا کانال پیدا نشد' });
  const mine = myMembership(chat, req.user._id);
  // ادمین (تغییر اطلاعات) برای همه؛ هر عضو فقط برای «خودش» و فقط وقتی ادمین allowMemberTags رو روشن کرده
  const isSelf = String(req.params.userId) === String(req.user._id);
  if (!mine || !(rights.can(chat, req.user._id, 'changeInfo') || (isSelf && chat.allowMemberTags))) return res.status(403).json({ error: 'اجازه‌ی تغییر برچسب را ندارید' });
  const target = chat.members.find((m) => String(m.user) === req.params.userId);
  if (!target) return res.status(404).json({ error: 'عضو پیدا نشد' });
  // کنترل‌کاراکتر/خط‌جدید و فاصله‌های اضافه حذف می‌شن (برچسب تک‌خطی)
  const tag = String(req.body?.tag ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 16);
  target.tag = tag;
  await chat.save();
  rights.logAction(chat._id, req.user._id, 'set_tag', target.user, tag);
  req.app.get('io')?.to(`chat:${chat._id}`).emit('group:updated', { chatId: chat._id, rolesChanged: true });
  res.json({ ok: true, tag });
});

// مالک قبلی ادمین (با همه‌ی دسترسی‌ها به‌جز «افزودن ادمین») می‌مونه؛ مالک جدید همه‌ی دسترسی‌ها رو داره.
router.post('/:chatId/transfer-ownership', requireAuth, async (req, res) => {
  const { userId, password } = req.body || {};
  const chat = await Chat.findById(req.params.chatId);
  if (!chat || !['group', 'channel'].includes(chat.type)) return res.status(404).json({ error: 'گروه یا کانال پیدا نشد' });
  const me = chat.members.find((m) => m.user.toString() === req.user._id.toString());
  if (!me || me.role !== 'owner') return res.status(403).json({ error: 'فقط مالک می‌تواند مالکیت را منتقل کند' });
  const target = chat.members.find((m) => m.user.toString() === String(userId));
  if (!target || target === me) return res.status(400).json({ error: 'عضو نامعتبر است' });
  const User = require('../models/User');
  const targetUser = await User.findById(target.user).select('isBot isSystem status');
  if (!targetUser || targetUser.isBot || targetUser.isSystem || targetUser.status === 'banned') {
    return res.status(400).json({ error: 'این کاربر نمی‌تواند مالک شود' });
  }
  const bcrypt = require('bcryptjs');
  if (!password || !(await bcrypt.compare(String(password), req.user.passwordHash))) {
    return res.status(401).json({ error: 'رمز عبور اشتباه است' });
  }
  target.role = 'owner';
  target.rights = undefined;
  target.restrictedUntil = null;
  me.role = 'admin';
  me.rights = Object.fromEntries(rights.ADMIN_RIGHTS.map((k) => [k, k !== 'addAdmins']));
  await chat.save();
  rights.logAction(chat._id, req.user._id, 'transfer_owner', target.user);
  req.app.get('io')?.to(`chat:${chat._id}`).emit('group:updated', { chatId: chat._id, rolesChanged: true });
  res.json({ ok: true });
});

// حذف عضو (یا خروج خودِ کاربر) - بعد از موفقیت، بقیه‌ی اعضا باید سندرکیِ گروه رو rotate کنن
// (forward secrecy: عضو حذف‌شده نباید بتونه پیام‌های بعدی گروه رو بخونه)
router.delete('/:chatId/members/:userId', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: 'چت یافت نشد' });
  const me = chat.members.find((m) => m.user.toString() === req.user._id.toString());
  const isSelfLeave = req.params.userId === req.user._id.toString();
  if (!isSelfLeave && (!me || !rights.can(chat, req.user._id, 'banUsers'))) {
    return res.status(403).json({ error: 'اجازه‌ی این کار رو نداری' });
  }
  // ادمین عادی نمی‌تونه مالک (یا ادمین دیگه) رو حذف کنه؛ فقط مالک می‌تونه ادمین رو حذف کنه
  const victim = chat.members.find((m) => m.user.toString() === req.params.userId);
  if (!isSelfLeave && victim && (victim.role === 'owner' || (victim.role === 'admin' && me.role !== 'owner'))) {
    return res.status(403).json({ error: 'اجازه‌ی حذف این عضو رو نداری' });
  }
  const wasOwner = victim?.role === 'owner';
  chat.members = chat.members.filter((m) => m.user.toString() !== req.params.userId);
  // «بن»: حذف + جلوگیری از بازگشت با لینک/افزودن
  const doBan = !isSelfLeave && (req.query.ban === '1' || req.query.ban === 'true');
  if (doBan && !(chat.banned || []).some((b) => b.toString() === req.params.userId)) chat.banned.push(req.params.userId);
  rights.logAction(chat._id, req.user._id, isSelfLeave ? 'leave' : doBan ? 'ban' : 'remove', isSelfLeave ? null : req.params.userId);
  // مالک که خارج می‌شه: مالکیت به قدیمی‌ترین ادمین (وگرنه قدیمی‌ترین عضو) منتقل می‌شه تا گروه بی‌صاحب نشه
  if (wasOwner && chat.members.length) {
    const heir = chat.members.filter((m) => m.role === 'admin')[0] || chat.members[0];
    heir.role = 'owner';
  }
  await chat.save();

  const io = req.app.get('io');
  const remainingMemberIds = await humanIds(chat.members.map((m) => m.user.toString()));
  io?.to(`chat:${chat._id}`).emit('group:membersChanged', {
    chatId: chat._id,
    memberIds: remainingMemberIds,
    removedUserId: req.params.userId,
    reason: 'removed',
  });
  io?.to(`user:${req.params.userId}`).emit('group:membersChanged', {
    chatId: chat._id,
    memberIds: remainingMemberIds,
    removedUserId: req.params.userId,
    reason: 'removed',
  });

  res.json(chat);
  // آخرین عضوِ انسانی رفت: گروه/کانال بی‌صاحبه و باید کامل پاک بشه (ربات‌ها به‌تنهایی گروه رو زنده نگه نمی‌دارن)
  if (['group', 'channel'].includes(chat.type) && remainingMemberIds.length === 0) {
    await purgeChats([chat._id]).catch((e) => console.error('[cleanup] purge empty chat:', e.message));
  }
});

// سکوت موقتِ یک عضو توسط مدیر (hours=0 یا خالی => نامحدود؛ unrestrict=true => برداشتن)
router.post('/:chatId/members/:userId/restrict', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId);
  if (!chat || !['group', 'channel'].includes(chat.type)) return res.status(404).json({ error: 'گروه یافت نشد' });
  if (!rights.can(chat, req.user._id, 'banUsers')) return res.status(403).json({ error: 'اجازه‌ی این کار رو نداری' });
  const target = chat.members.find((m) => m.user.toString() === req.params.userId);
  if (!target || target.role !== 'member') return res.status(400).json({ error: 'فقط اعضای عادی قابل محدودسازی‌اند' });
  const hours = Number(req.body.hours) || 0;
  target.restrictedUntil = req.body.unrestrict ? null : new Date(Date.now() + (hours > 0 ? hours * 3600 * 1000 : 10 * 365 * 86400 * 1000));
  await chat.save();
  rights.logAction(chat._id, req.user._id, req.body.unrestrict ? 'unrestrict' : 'restrict', req.params.userId, hours ? `${hours}h` : 'forever');
  req.app.get('io')?.to(`chat:${chat._id}`).emit('group:updated', { chatId: chat._id, rolesChanged: true });
  res.json({ ok: true, restrictedUntil: target.restrictedUntil });
});

// فهرست محروم‌شده‌ها و رفع محرومیت
router.get('/:chatId/banned', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId).populate('banned', 'username displayName avatarUrl isBot');
  if (!chat || !rights.can(chat, req.user._id, 'banUsers')) return res.status(403).json({ error: 'اجازه‌ی این کار رو نداری' });
  res.json(chat.banned);
});
router.post('/:chatId/unban/:userId', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId);
  if (!chat || !rights.can(chat, req.user._id, 'banUsers')) return res.status(403).json({ error: 'اجازه‌ی این کار رو نداری' });
  chat.banned = chat.banned.filter((b) => b.toString() !== req.params.userId);
  await chat.save();
  rights.logAction(chat._id, req.user._id, 'unban', req.params.userId);
  res.json({ ok: true });
});

// درخواست‌های عضویت (وقتی «تأیید ورود» روشنه)
router.get('/:chatId/join-requests', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId).populate('joinRequests.user', 'username displayName avatarUrl isBot');
  if (!chat || !rights.can(chat, req.user._id, 'inviteUsers')) return res.status(403).json({ error: 'اجازه‌ی این کار رو نداری' });
  res.json(chat.joinRequests.filter((r) => r.user));
});
router.post('/:chatId/join-requests/:userId', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId);
  if (!chat || !rights.can(chat, req.user._id, 'inviteUsers')) return res.status(403).json({ error: 'اجازه‌ی این کار رو نداری' });
  const uid = req.params.userId;
  const had = chat.joinRequests.some((r) => r.user.toString() === uid);
  chat.joinRequests = chat.joinRequests.filter((r) => r.user.toString() !== uid);
  const approve = req.body.approve === true;
  const io = req.app.get('io');
  if (had && approve && !chat.members.some((m) => m.user.toString() === uid) && !(chat.banned || []).some((b) => b.toString() === uid)) {
    chat.members.push({ user: uid, role: 'member' });
    await chat.save();
    rights.logAction(chat._id, req.user._id, 'approve_join', uid);
    const payload = { chatId: chat._id, memberIds: await humanIds(chat.members.map((m) => m.user.toString())), addedUserIds: [uid], reason: 'added' };
    io?.to(`chat:${chat._id}`).emit('group:membersChanged', payload);
    io?.to(`user:${uid}`).emit('group:membersChanged', payload);
  } else {
    await chat.save();
    if (had) rights.logAction(chat._id, req.user._id, 'reject_join', uid);
  }
  res.json({ ok: true });
});

// گزارش اقدام‌های مدیریتی (فقط ادمین/مالک)
router.get('/:chatId/admin-log', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId).select('members type');
  const me = chat && chat.members.find((m) => m.user.toString() === req.user._id.toString());
  if (!me || me.role === 'member') return res.status(403).json({ error: 'اجازه‌ی این کار رو نداری' });
  const logs = await ChatAdminLog.find({ chat: chat._id }).sort({ createdAt: -1 }).limit(100).populate('actor target', 'displayName username');
  res.json(logs);
});

// حذف کامل گروه/کانال (فقط مالک)
router.delete('/:chatId', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId);
  if (!chat || !['group', 'channel'].includes(chat.type)) return res.status(404).json({ error: 'گروه یافت نشد' });
  const me = chat.members.find((m) => m.user.toString() === req.user._id.toString());
  if (!me || me.role !== 'owner') return res.status(403).json({ error: 'فقط مالک می‌تونه گروه رو حذف کنه' });
  const io = req.app.get('io');
  chat.members.forEach((m) => io?.to(`user:${m.user}`).emit('group:membersChanged', { chatId: chat._id, memberIds: [], removedUserId: m.user.toString(), reason: 'removed' }));
  // حذف کامل: پیام‌ها، لاگ ادمین، زمان‌بندی‌شده‌ها، کلیدهای گروه، پوشه‌ها، حافظه‌ی ربات‌ها و فایل‌های آپلودی (utils/dataCleanup.js)
  await purgeChats([chat._id]);
  res.json({ ok: true });
});


// آمار گروه/کانال برای مالک و ادمین‌ها: اعضا، عضویت‌های اخیر، پیام‌های روزانه‌ی ۱۴ روز اخیر و پربازدیدترین پست‌های ۳۰ روز اخیر.
// توجه: خروج اعضا ثبت نمی‌شه، پس «عضویت‌های اخیر» فقط اعضای فعلی‌ای هستن که تو اون بازه پیوستن.
router.get('/:chatId/stats', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId).select('type members.user members.role members.joinedAt');
  if (!chat || !['group', 'channel'].includes(chat.type)) return res.status(404).json({ error: 'گروه یا کانال پیدا نشد' });
  const me = myMembership(chat, req.user._id);
  if (!me || !['owner', 'admin'].includes(me.role)) return res.status(403).json({ error: 'فقط مالک و ادمین‌ها به آمار دسترسی دارند' });

  const DAY = 86400000;
  const now = Date.now();
  const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
  const joined = (days) => chat.members.filter((m) => m.joinedAt && now - new Date(m.joinedAt).getTime() <= days * DAY).length;

  const since14 = new Date(now - 14 * DAY);
  const rows = await Message.aggregate([
    { $match: { chat: chat._id, createdAt: { $gte: since14 }, deletedForEveryone: { $ne: true }, type: { $ne: 'system_action' } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, n: { $sum: 1 } } },
  ]);
  const byDay = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  const messagesPerDay = Array.from({ length: 14 }, (_, i) => {
    const d = dayKey(now - (13 - i) * DAY);
    return { date: d, count: byDay[d] || 0 };
  });

  const top = await Message.find({ chat: chat._id, createdAt: { $gte: new Date(now - 30 * DAY) }, deletedForEveryone: { $ne: true }, type: { $ne: 'system_action' }, views: { $gt: 0 } })
    .sort({ views: -1 }).limit(5).select('content type views createdAt e2e groupE2e');
  const topPosts = top.map((m) => {
    let preview = '';
    if (m.type === 'text' && !m.e2e && !m.groupE2e) { try { preview = String(decryptText(m.content) || '').slice(0, 80); } catch (e) { preview = ''; } }
    return { id: m._id, type: m.type, preview, views: m.views, createdAt: m.createdAt };
  });

  res.json({
    type: chat.type,
    memberCount: chat.members.length,
    adminCount: chat.members.filter((m) => m.role !== 'member').length,
    joinedLast7d: joined(7),
    joinedLast30d: joined(30),
    messagesPerDay,
    topPosts,
  });
});

// جزئیات یک چت (برای هدر و بنر پیام پین‌شده)
router.get('/:chatId', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId)
    .populate('members.user', 'username displayName avatarUrl isOnline lastSeen isBot')
    .populate('pinnedMessage')
    .populate('pinnedMessages');
  if (!chat) return res.status(404).json({ error: 'چت یافت نشد' });
  const isMember = chat.members.some((m) => m.user._id.toString() === req.user._id.toString());
  if (!isMember) return res.status(403).json({ error: 'شما عضو این چت نیستید' });

  const obj = chat.toObject();
  // حذف‌شده‌ها (قبل از این اصلاح یا از مسیرهای دیگه) تو پین نمونن
  if (obj.pinnedMessage?.deletedForEveryone) {
    obj.pinnedMessage = null;
    Chat.updateOne({ _id: chat._id }, { pinnedMessage: null }).catch(() => {});
  }
  obj.pinnedMessages = (obj.pinnedMessages || []).filter((m) => m && !m.deletedForEveryone);
  if (obj.type !== 'secret') for (const m of obj.pinnedMessages) m.content = decryptText(m.content);
  if (obj.pinnedMessage && obj.type !== 'secret') obj.pinnedMessage.content = decryptText(obj.pinnedMessage.content);
  const me = myMembership(chat, req.user._id);
  obj.myState = { muted: !!(me?.mutedUntil && me.mutedUntil > new Date()), archived: !!me?.archived, pinnedInList: !!me?.pinnedInList, wallpaper: me?.wallpaper || null, role: me?.role || 'member', rights: me?.role === 'owner' ? Object.fromEntries(rights.ADMIN_RIGHTS.map((k) => [k, true])) : me?.role === 'admin' ? { ...rights.DEFAULT_ADMIN_RIGHTS, ...(me.rights || {}) } : {}, restrictedUntil: rights.restrictionRemaining(chat, req.user._id) };
  // لینک دعوت و درخواست‌های عضویت فقط برای کسی که حق دعوت داره؛ لیست محروم‌ها هیچ‌وقت تو این جواب نیست
  if (!rights.can(chat, req.user._id, 'inviteUsers')) { delete obj.joinRequests; delete obj.inviteCode; }
  delete obj.banned;
  if (obj.joinRequests) obj.joinRequestCount = obj.joinRequests.length;
  res.json(obj);
});


// برچسب‌گذاری پیام‌های «پیام‌های ذخیره‌شده» (فقط چتِ saved خودِ کاربر).
router.post('/:chatId/messages/:messageId/tags', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId).select('type members.user');
  if (!chat || chat.type !== 'saved' || !myMembership(chat, req.user._id)) return res.status(403).json({ error: 'فقط در پیام‌های ذخیره‌شده‌ی خودتان' });
  if (!mongoose.isValidObjectId(req.params.messageId)) return res.status(400).json({ error: 'پیام نامعتبر است' });
  const tags = require('../utils/messageTags').sanitizeTags(req.body?.tags);
  if (!tags) return res.status(400).json({ error: 'برچسب‌ها نامعتبر است' });
  const msg = await Message.findOneAndUpdate({ _id: req.params.messageId, chat: chat._id }, tags.length ? { $set: { tags } } : { $unset: { tags: '' } }, { new: true }).select('_id tags');
  if (!msg) return res.status(404).json({ error: 'پیام پیدا نشد' });
  res.json({ ok: true, tags: msg.tags || [] });
});

// فهرست برچسب‌های استفاده‌شده + تعداد (برای نوار فیلتر)
router.get('/:chatId/tags', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.chatId).select('type members.user');
  if (!chat || chat.type !== 'saved' || !myMembership(chat, req.user._id)) return res.status(403).json({ error: 'دسترسی ندارید' });
  const rows = await Message.aggregate([
    { $match: { chat: chat._id, tags: { $exists: true, $ne: [] }, deletedForEveryone: { $ne: true } } },
    { $unwind: '$tags' },
    { $group: { _id: '$tags', count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: 50 },
  ]);
  res.json(rows.map((r) => ({ tag: r._id, count: r.count })));
});

// پیام‌های یک چت (صفحه‌بندی شده)
router.get('/:chatId/messages', requireAuth, async (req, res) => {
  const { chatId } = req.params;
  const { before, after, tag, topic } = req.query;
  const limit = Math.floor(clampNumber(req.query.limit, 1, 1000, 30));

  const chat = await Chat.findById(chatId);
  if (!chat) return res.status(404).json({ error: 'چت یافت نشد' });
  const isMember = chat.members.some((m) => m.user.toString() === req.user._id.toString());
  if (!isMember) return res.status(403).json({ error: 'شما عضو این چت نیستید' });

  const query = { chat: chatId, deletedFor: { $ne: req.user._id } };
  // فیلتر سمت سرور: برچسبِ «پیام‌های ذخیره‌شده» و تاپیکِ گروه (تا فیلتر روی کل تاریخچه کار کنه، نه فقط پیام‌های بارگذاری‌شده)
  if (tag && chat.type === 'saved') query.tags = String(tag).toLowerCase().slice(0, 20);
  if (topic && chat.type === 'group') {
    if (topic === 'general') query.topic = null;
    else if (mongoose.isValidObjectId(topic)) query.topic = topic;
    else return res.status(400).json({ error: 'تاپیک نامعتبر است' });
  }
  const isValidDate = (v) => !Number.isNaN(new Date(v).getTime());
  if ((before && !isValidDate(before)) || (after && !isValidDate(after))) return res.status(400).json({ error: 'تاریخ نامعتبر است' });
  if (before) query.createdAt = { $lt: new Date(before) };
  // «after» یعنی «فقط چیزهایی که جدیدتر از این هستن» — برای سینک آرشیو دائمیِ گوشی با سرور،
  // نه برای صفحه‌بندیِ تاریخچه‌ی قدیمی (که «before» انجامش می‌ده)
  if (after) query.createdAt = { ...(query.createdAt || {}), $gt: new Date(after) };
  const me = chat.members.find((m) => m.user.toString() === req.user._id.toString());
  if (me?.clearedAt) {
    query.createdAt = { ...(query.createdAt || {}), $gt: me.clearedAt };
  }

  // برای «after» نباید محدود به ۳۰ تا بمونه (ممکنه کاربر مدتی آفلاین بوده و پیام‌های زیادی
  // جا مونده باشه که باید همه‌شون سینک بشن)، ولی برای جلوگیری از پاسخ خیلی سنگین یه سقف منطقی می‌ذاریم
  const effectiveLimit = after ? Math.min(limit, 1000) : Math.min(limit, 100);
  const sortDir = after ? 1 : -1;

  const messages = await Message.find(query)
    .sort({ createdAt: sortDir })
    .limit(effectiveLimit)
    .populate('sender', 'username displayName avatarUrl isBot')
    .populate('replyTo');

  const decrypted = messages.map((m) => {
    const obj = anonymizeChannelSender(chat, m.toObject());
    if (chat.type !== 'secret' && !obj.e2e?.senderDeviceId && !obj.groupE2e?.ciphertext) {
      obj.content = decryptText(obj.content);
      if (obj.replyTo) obj.replyTo.content = decryptText(obj.replyTo.content);
    }
    return obj;
  });

  res.json(after ? decrypted : decrypted.reverse());
});

module.exports = router;
