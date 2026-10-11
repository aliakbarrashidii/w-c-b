const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('../models/User');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const ChatAdminLog = require('../models/ChatAdminLog');
const ScheduledMessage = require('../models/ScheduledMessage');
const SenderKeyDistribution = require('../models/SenderKeyDistribution');
const Activity = require('../models/Activity');
const BotMemory = require('../models/BotMemory');
const BotUpdate = require('../models/BotUpdate');
const Bot = require('../models/Bot');
const StickerPack = require('../models/StickerPack');
const Session = require('../models/Session');
const Device = require('../models/Device');

// پاک‌سازی داده‌هایی که دیگه کسی بهشون نیاز نداره: ربات حذف‌شده، گروه/کانال حذف‌شده و چتِ خصوصیِ رهاشده.
// قبلاً فقط ردیف‌های Message/Chat پاک می‌شد؛ فایل‌های آپلودی (uploads/) هیچ‌وقت از دیسک حذف نمی‌شدن،
// و سندهای وابسته (حافظه‌ی ربات، پیام‌های زمان‌بندی‌شده، کلیدهای گروه، پوشه‌ها، اکتیویتی) یتیم می‌موندن.

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

// URLِ ما → مسیر فایل روی دیسک (فقط داخل uploads/، ضد path traversal). برای URL بیرونی/نامعتبر null.
function uploadPathFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let pathname;
  try { pathname = new URL(url, 'http://local').pathname; } catch { return null; }
  if (!pathname.startsWith('/uploads/')) return null;
  const name = path.basename(decodeURIComponent(pathname));
  if (!name || name.startsWith('.')) return null;
  const full = path.join(UPLOAD_DIR, name);
  return full.startsWith(UPLOAD_DIR + path.sep) ? full : null;
}

// آیا هنوز جایی به این URL اشاره می‌کنه؟ (فوروارد یه فایلِ مشترک رو کپی می‌کنه؛ آواتار/استیکر هم همین‌طور)
async function isReferenced(url) {
  const [msg, sched, user, chat, pack] = await Promise.all([
    Message.exists({ mediaUrl: url }),
    ScheduledMessage.exists({ mediaUrl: url, status: 'pending' }),
    User.exists({ $or: [{ avatarUrl: url }, { avatarUrls: url }] }),
    Chat.exists({ avatarUrl: url }),
    StickerPack.exists({ $or: [{ iconUrl: url }, { 'stickers.url': url }] }),
  ]);
  return !!(msg || sched || user || chat || pack);
}

// فایل‌های بدون هیچ ارجاعِ باقی‌مونده رو از دیسک پاک می‌کنه. خطای تکی بقیه رو متوقف نمی‌کنه. تعداد حذف‌شده‌ها رو برمی‌گردونه.
async function unlinkIfUnreferenced(urls) {
  let removed = 0;
  for (const url of [...new Set((urls || []).filter(Boolean))]) {
    const file = uploadPathFromUrl(url);
    if (!file) continue;
    try {
      if (await isReferenced(url)) continue;
      await fs.promises.unlink(file);
      removed++;
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[cleanup] حذف فایل ناموفق:', path.basename(file), e.message);
    }
  }
  return removed;
}

// پیام‌های حذف‌شده/منقضی نباید به‌صورت پین معلق بمونن (هم پین قدیمی تکی، هم لیست پین چندتایی)
async function unpinMessages(messageIds) {
  const ids = (Array.isArray(messageIds) ? messageIds : [messageIds]).filter(Boolean);
  if (!ids.length) return;
  await Promise.all([
    Chat.updateMany({ pinnedMessage: { $in: ids } }, { pinnedMessage: null }),
    Chat.updateMany({ pinnedMessages: { $in: ids } }, { $pull: { pinnedMessages: { $in: ids } } }),
  ]);
}

// حذف کامل چت‌ها + همه‌ی وابسته‌هاشون (پیام‌ها، لاگ ادمین، زمان‌بندی‌شده‌ها، کلیدهای گروه، اکتیویتی، حافظه‌ی ربات، پوشه‌ها، فایل‌ها)
async function purgeChats(chatIds) {
  const ids = (chatIds || []).map((c) => new mongoose.Types.ObjectId(String(c)));
  if (!ids.length) return;
  const [chats, msgMedia, schedMedia] = await Promise.all([
    Chat.find({ _id: { $in: ids } }).select('avatarUrl'),
    Message.distinct('mediaUrl', { chat: { $in: ids }, mediaUrl: { $ne: '' } }),
    ScheduledMessage.distinct('mediaUrl', { chat: { $in: ids }, mediaUrl: { $ne: '' } }),
  ]);
  await Promise.all([
    Message.deleteMany({ chat: { $in: ids } }),
    ChatAdminLog.deleteMany({ chat: { $in: ids } }),
    ScheduledMessage.deleteMany({ chat: { $in: ids } }),
    SenderKeyDistribution.deleteMany({ groupId: { $in: ids } }),
    Activity.deleteMany({ chat: { $in: ids } }),
    BotMemory.deleteMany({ chat: { $in: ids } }),
    User.updateMany({ 'folders.chatIds': { $in: ids } }, { $pull: { 'folders.$[].chatIds': { $in: ids } } }),
  ]);
  await Chat.deleteMany({ _id: { $in: ids } });
  // فایل‌ها آخر: بعد از حذف پیام‌ها دیگه ارجاعی نمونده
  await unlinkIfUnreferenced([...msgMedia, ...schedMedia, ...chats.map((c) => c.avatarUrl)]);
}

// حذف کامل یه ربات: خودِ ربات، کاربر ربات، حافظه‌ی AI، صف آپدیت‌ها، و «چت‌های خصوصی با ربات» (گفتگوی کاربر با ربات
// بعد از حذفش هیچ کاربردی نداره). پیام‌های ربات تو گروه‌ها می‌مونه چون جزء گفتگوی بقیه‌ست؛ فقط عضویتش برداشته می‌شه.
async function purgeBot(bot) {
  const botChats = await Chat.find({ 'members.user': bot.user }).select('type');
  const privateIds = botChats.filter((c) => c.type === 'private').map((c) => c._id);
  const groupIds = botChats.filter((c) => c.type !== 'private').map((c) => c._id);
  await purgeChats(privateIds);
  if (groupIds.length) await Chat.updateMany({ _id: { $in: groupIds } }, { $pull: { members: { user: bot.user } } });
  const botUser = await User.findById(bot.user).select('avatarUrl avatarUrls');
  await Promise.all([
    BotMemory.deleteMany({ bot: bot._id }),
    BotUpdate.deleteMany({ bot: bot._id }),
    ScheduledMessage.deleteMany({ sender: bot.user }),
    Activity.deleteMany({ $or: [{ actor: bot.user }, { recipient: bot.user }] }),
  ]);
  await User.deleteOne({ _id: bot.user });
  await Bot.deleteOne({ _id: bot._id });
  await unlinkIfUnreferenced([botUser?.avatarUrl, ...(botUser?.avatarUrls || [])]);
}

// چت خصوصی/مخفیِ رهاشده: همه‌ی اعضا تاریخچه رو پاک کردن (clearedAt بعد از آخرین فعالیت) و هیچ‌کس تنظیمِ شخصی
// (والپیپر، پین، میوت، آرشیو، علامت خوانده‌نشده) نداره که از دست بره → کل چت پاک می‌شه. اگه تنظیمی هست، فقط سند کوچک چت می‌مونه.
function isAbandoned(chat, now = Date.now()) {
  if (!chat || !['private', 'secret'].includes(chat.type)) return false;
  const last = chat.lastActivityAt ? new Date(chat.lastActivityAt).getTime() : 0;
  return chat.members.every((m) => {
    const cleared = m.clearedAt && new Date(m.clearedAt).getTime() >= last;
    const hasState = m.wallpaper || m.pinnedInList || m.archived || m.markedUnread || (m.mutedUntil && new Date(m.mutedUntil).getTime() > now);
    return cleared && !hasState;
  });
}

async function purgeIfAbandoned(chat) {
  if (!isAbandoned(chat)) return false;
  await purgeChats([chat._id]);
  return true;
}


// حذف حساب کاربر. حساب به یه «پوسته‌ی ناشناس» تبدیل می‌شه (بدون هیچ اطلاعات شخصی) نه اینکه سند User کامل حذف بشه؛
// چون پیام‌های قدیمیِ این کاربر تو گروه‌ها هنوز بهش ارجاع دارن (populate('sender') نباید null بشه و کلاینت‌ها خراب بشن).
//  • رباتای خودش: purgeBot  • چت‌های خصوصی/مخفی/ذخیره‌شده: کامل پاک (طرف مقابل با رویداد خبردار می‌شه)
//  • گروه/کانال: عضویت برداشته می‌شه؛ اگه مالک بود به یه ادمین/عضو انسانی منتقل می‌شه؛ اگه عضو انسانی نمونده کامل پاک
//  • نشست‌ها، دستگاه‌ها، توکن پوش، کلیدهای گروه، اکتیویتی، زمان‌بندی‌شده‌ها پاک؛ آواتارها از دیسک حذف
async function purgeUserAccount(userId, io) {
  const { humanIds } = require('./botEngine'); // lazy: botEngine خودش از مدل‌ها استفاده می‌کنه
  const user = await User.findById(userId);
  if (!user) return;
  const emitRemoved = (targetId, chatId, memberIds = []) =>
    io?.to(`user:${targetId}`).emit('group:membersChanged', { chatId, memberIds, removedUserId: String(targetId), reason: 'removed' });

  const bots = await Bot.find({ owner: userId });
  for (const bot of bots) await purgeBot(bot);

  const chats = await Chat.find({ 'members.user': userId });
  for (const chat of chats) {
    if (!['group', 'channel'].includes(chat.type)) {
      for (const m of chat.members) if (String(m.user) !== String(userId)) emitRemoved(m.user, chat._id);
      await purgeChats([chat._id]);
      continue;
    }
    const wasOwner = chat.members.find((m) => String(m.user) === String(userId))?.role === 'owner';
    chat.members = chat.members.filter((m) => String(m.user) !== String(userId));
    const humans = await humanIds(chat.members.map((m) => String(m.user)));
    if (!humans.length) { await purgeChats([chat._id]); continue; }
    if (wasOwner) {
      const humanSet = new Set(humans);
      const humanMembers = chat.members.filter((m) => humanSet.has(String(m.user)));
      const heir = humanMembers.find((m) => m.role === 'admin') || humanMembers[0];
      heir.role = 'owner';
    }
    await chat.save();
    for (const id of humans) io?.to(`user:${id}`).emit('group:membersChanged', { chatId: chat._id, memberIds: humans, removedUserId: String(userId), reason: 'removed' });
  }

  await Promise.all([
    Session.deleteMany({ user: userId }),
    Device.deleteMany({ user: userId }),
    ScheduledMessage.deleteMany({ sender: userId }),
    Activity.deleteMany({ $or: [{ actor: userId }, { recipient: userId }] }),
    SenderKeyDistribution.deleteMany({ $or: [{ toUser: userId }, { fromUser: userId }] }),
  ]);

  const oldAvatars = [user.avatarUrl, ...(user.avatarUrls || [])];
  const randomHash = require('crypto').randomBytes(32).toString('hex'); // هیچ رمزی با این جور نمی‌شه؛ ورود غیرممکنه
  user.set({
    username: `deleted_${String(user._id)}`, // کامل ObjectId تا یکتا بودن username قطعی باشه
    displayName: 'Deleted Account',
    passwordHash: randomHash,
    avatarUrl: '', avatarUrls: [], bio: '', note: '', phone: '', phoneHash: undefined, coverId: '', // phoneHash باید حذف (unset) بشه نه '' - ایندکس یکتا/sparse دارد
    twoFactorEnabled: false, twoFactorSecret: '',
    pushTokens: [], savedContacts: [], folders: [],
    isOnline: false, status: 'deleted',
    telegramId: undefined, telegramUsername: undefined,
  });
  await user.save();
  await unlinkIfUnreferenced(oldAvatars);
  io?.in(`user:${userId}`).disconnectSockets(true);
}

module.exports = { unpinMessages, purgeUserAccount, isAbandoned, purgeChats, purgeBot, purgeIfAbandoned, unlinkIfUnreferenced, uploadPathFromUrl };
