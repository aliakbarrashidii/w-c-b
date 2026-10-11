const ChatAdminLog = require('../models/ChatAdminLog');

// حقوق قابل‌تنظیمِ هر ادمین (مالک همه را دارد). ادمین جدید همه به‌جز addAdmins رو داره
const ADMIN_RIGHTS = ['changeInfo', 'deleteMessages', 'banUsers', 'inviteUsers', 'pinMessages', 'addAdmins'];
const DEFAULT_ADMIN_RIGHTS = { changeInfo: true, deleteMessages: true, banUsers: true, inviteUsers: true, pinMessages: true, addAdmins: false };
// مجوزهای پیش‌فرضِ «عضو عادی» که مدیر برای کل گروه تنظیم می‌کنه
const MEMBER_PERMS = ['sendMessages', 'sendMedia', 'sendStickers', 'sendPolls', 'addMembers', 'pinMessages', 'changeInfo'];

const memberOf = (chat, userId) => chat.members.find((m) => (m.user._id || m.user).toString() === userId.toString());

function can(chat, userId, right) {
  const m = memberOf(chat, userId);
  if (!m) return false;
  if (m.role === 'owner') return true;
  if (m.role === 'admin') {
    const r = { ...DEFAULT_ADMIN_RIGHTS, ...(m.rights || {}) };
    return !!r[right];
  }
  return false;
}

// آیا عضو عادی اجازه‌ی این نوع کار رو داره؟ (ادمین/مالک همیشه دارن). محدودیتِ موقتِ فردی هم لحاظ می‌شه
function memberAllowed(chat, userId, perm) {
  const m = memberOf(chat, userId);
  if (!m) return false;
  if (m.role !== 'member') return true;
  if (m.restrictedUntil && new Date(m.restrictedUntil) > new Date()) return false;
  const p = chat.permissions || {};
  return p[perm] !== false;
}

const restrictionRemaining = (chat, userId) => {
  const m = memberOf(chat, userId);
  return m?.restrictedUntil && new Date(m.restrictedUntil) > new Date() ? new Date(m.restrictedUntil) : null;
};

const logAction = (chatId, actor, action, target, extra) => ChatAdminLog.create({ chat: chatId, actor, action, target: target || null, extra: extra || '' }).catch(() => {});

module.exports = { ADMIN_RIGHTS, DEFAULT_ADMIN_RIGHTS, MEMBER_PERMS, can, memberAllowed, restrictionRemaining, logAction, memberOf };
