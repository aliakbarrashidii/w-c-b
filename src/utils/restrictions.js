const User = require('../models/User');
const Message = require('../models/Message');
const { ensureSystemUser, getOrCreateSystemChat } = require('./systemAccount');

// هر کلید یه قابلیتِ قابل‌محدودسازیه؛ ادمین از پنل تیک می‌زنه
const FEATURES = {
  send_messages: 'ارسال پیام متنی',
  send_media: 'ارسال عکس/ویدیو/فایل',
  voice: 'ارسال ویس و پیام ویدیویی',
  stickers: 'ارسال استیکر',
  new_chats: 'شروع چت جدید با دیگران',
  calls: 'تماس صوتی/تصویری',
  create_groups: 'ساخت گروه/کانال',
  join_groups: 'عضویت/افزودن به گروه',
  profile_edit: 'ویرایش پروفایل',
  file_reports: 'ثبت گزارش',
};

const MEDIA_FEATURE = { image: 'send_media', video: 'send_media', file: 'send_media', voice: 'voice', video_note: 'voice', sticker: 'stickers', text: 'send_messages', poll: 'send_messages', location: 'send_messages', contact: 'send_messages' };

function activeRestrictions(user) {
  const now = Date.now();
  return (user.restrictions || []).filter((r) => !r.until || new Date(r.until).getTime() > now);
}

// اگه این قابلیت برای کاربر محدود باشه، همون رکوردِ محدودیت رو برمی‌گردونه (وگرنه null)
function findRestriction(user, feature) {
  return activeRestrictions(user).find((r) => r.features.includes(feature)) || null;
}

function restrictionMessage(r) {
  const until = r.until ? `تا ${new Date(r.until).toLocaleDateString('fa-IR')}` : 'تا اطلاع ثانوی';
  return `این قابلیت روی حساب شما محدود شده است (${until}).${r.reason ? ' دلیل: ' + r.reason : ''}`;
}

// برای هندلرها: اگه محدود بود پیام خطا، وگرنه null
async function guard(userOrId, feature) {
  const user = userOrId?.restrictions ? userOrId : await User.findById(userOrId).select('restrictions');
  if (!user) return null;
  const r = findRestriction(user, feature);
  return r ? restrictionMessage(r) : null;
}

async function addRestriction(userId, { features, days, reason, source = 'admin' }) {
  const clean = (features || []).filter((f) => FEATURES[f]);
  if (!clean.length) return null;
  const until = days && Number(days) > 0 ? new Date(Date.now() + Number(days) * 86400000) : null;
  const user = await User.findByIdAndUpdate(userId, { $push: { restrictions: { features: clean, until, reason: reason || '', source } } }, { new: true });
  return { user, until, features: clean };
}

// پیام رسمی از طرف اکانت WizChat تو چتِ سیستمیِ کاربر
async function notifyUser(app, userId, text) {
  const chat = await getOrCreateSystemChat(userId);
  const systemUserId = await ensureSystemUser();
  const message = await Message.create({ chat: chat._id, sender: systemUserId, type: 'text', content: require('./crypto').encryptText(text) });
  await message.populate('sender', 'username displayName avatarUrl');
  chat.lastMessage = message._id;
  chat.lastActivityAt = new Date();
  await chat.save();
  const io = app.get('io');
  const out = message.toObject();
  out.content = text;
  io?.to(`chat:${chat._id}`).emit('message:new', out);
  io?.to(`user:${userId}`).emit('group:membersChanged', { chatId: chat._id, memberIds: [userId.toString()], addedUserIds: [userId.toString()], reason: 'added' });
}

module.exports = { FEATURES, MEDIA_FEATURE, activeRestrictions, findRestriction, restrictionMessage, guard, addRestriction, notifyUser };
