// قواعد دسترسی ادمین/ناظر: ناظر (moderator) فقط روی «کاربر عادی» می‌تونه عمل کنه؛ روی ادمین/ناظر دیگه فقط ادمین.
// (قبلاً هر ناظری می‌تونست حساب ادمین رو معلق/محدود کنه = قفل‌کردنِ ادمین بیرونِ سیستم)
function canActOn(actorRole, targetRole) {
  return actorRole === 'admin' || (actorRole === 'moderator' && (targetRole || 'user') === 'user');
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = { canActOn, clampNumber };

// آیا این کاربر (ادمین/ناظر) مجازه پیام‌های یک چت رو ببینه؟ ادمین همیشه؛ ناظر بسته به تنظیم moderatorChatAccess:
// 'all' (پیش‌فرض) یا 'reported' (فقط چتِ دارای گزارش باز). `openReportedChatIds` فقط وقتی لازمه که حالت reported باشه.
function moderatorMayViewChat({ role, access, chatId, openReportedChatIds = [] }) {
  if (role === 'admin') return true;
  if (role !== 'moderator') return false;
  if (access !== 'reported') return true;
  return openReportedChatIds.map(String).includes(String(chatId));
}
module.exports.moderatorMayViewChat = moderatorMayViewChat;
