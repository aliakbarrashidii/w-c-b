const User = require('../models/User');
const Message = require('../models/Message');
const Broadcast = require('../models/Broadcast');
const { ensureSystemUser, getOrCreateSystemChat } = require('./systemAccount');
const { encryptText } = require('./crypto');
const { sendPushNotifications } = require('./push');

// مقایسه‌ی نسخه‌ی عددی «1.2.10» با «1.3» (بخش‌های ناموجود = 0)
function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function buildFilter(target = {}) {
  const f = { isSystem: { $ne: true }, isBot: { $ne: true }, status: { $ne: 'banned' } };
  if (target.all) return f;
  if (target.languages?.length) f['client.language'] = { $in: target.languages };
  if (target.platforms?.length) f['client.platform'] = { $in: target.platforms };
  return f;
}

// برای نسخه باید تو کد فیلتر کنیم (رشته‌ی نسخه مقایسه‌ی عددی می‌خواد)
function matchesVersion(user, target = {}) {
  if (target.all || !target.maxAppVersion) return true;
  // کاربری که نسخه‌اش اصلاً گزارش نشده = احتمالاً خیلی قدیمی؛ شاملش می‌کنیم
  return !user.client?.appVersion || cmpVersion(user.client.appVersion, target.maxAppVersion) < 0;
}

async function countRecipients(target) {
  const users = await User.find(buildFilter(target)).select('client').lean();
  return users.filter((u) => matchesVersion(u, target)).length;
}

async function sendToUser(app, systemUserId, user, text, mediaMeta) {
  const chat = await getOrCreateSystemChat(user._id);
  const message = await Message.create({
    chat: chat._id,
    sender: systemUserId,
    type: mediaMeta ? 'system_action' : 'text',
    content: encryptText(text),
    ...(mediaMeta ? { mediaMeta } : {}),
  });
  await message.populate('sender', 'username displayName avatarUrl');
  chat.lastMessage = message._id;
  chat.lastActivityAt = new Date();
  await chat.save();
  const io = app.get('io');
  const out = message.toObject();
  out.content = text;
  io?.to(`chat:${chat._id}`).emit('message:new', out);
  // اگه چت تازه ساخته شده، سوکتِ زنده هنوز تو روم نیست
  io?.to(`user:${user._id}`).emit('group:membersChanged', { chatId: chat._id, memberIds: [String(user._id)], addedUserIds: [String(user._id)], reason: 'added' });
  return chat;
}

// ارسال در پس‌زمینه (HTTP سریع جواب می‌ده): دسته‌های ۲۰تایی برای فشار نیاوردن به DB
async function runBroadcast(app, broadcastId) {
  const b = await Broadcast.findById(broadcastId);
  if (!b) return;
  const systemUserId = await ensureSystemUser();
  const users = (await User.find(buildFilter(b.target)).select('_id pushTokens client notificationSettings').lean()).filter((u) => matchesVersion(u, b.target));
  b.recipients = users.length;
  await b.save();
  const mediaMeta = b.kind === 'update' && b.link ? { action: 'open_link', url: b.link } : null;
  let delivered = 0;
  let failed = 0;
  for (let i = 0; i < users.length; i += 20) {
    const batch = users.slice(i, i + 20);
    await Promise.all(
      batch.map(async (u) => {
        try {
          const chat = await sendToUser(app, systemUserId, u, b.text, mediaMeta);
          delivered++;
          if (u.notificationSettings?.enabled !== false && u.pushTokens?.length) {
            sendPushNotifications(u.pushTokens, { title: 'WizChat', body: u.notificationSettings?.preview === false ? 'پیام جدید' : b.text.slice(0, 120), data: { chatId: String(chat._id), type: 'message', recipientId: String(u._id) } }).catch(() => {});
          }
        } catch (err) {
          failed++;
          console.error('[broadcast] خطا برای کاربر', String(u._id), err.message);
        }
      })
    );
    b.delivered = delivered;
    b.failed = failed;
    await b.save();
  }
  b.status = 'done';
  await b.save();
}

module.exports = { buildFilter, matchesVersion, countRecipients, runBroadcast, cmpVersion };
