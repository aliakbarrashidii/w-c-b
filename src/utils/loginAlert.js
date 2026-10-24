// پوشِ «ورود جدید به حساب» برای دستگاه‌های قبلی (مثل تلگرام): تا قبل از این، هشدار فقط داخل چتِ سیستمی بود و
// کاربری که اپ را باز نمی‌کرد از ورودِ غریبه خبردار نمی‌شد. این یک هشدار امنیتی است: «مزاحم نشوید» آن را قطع نمی‌کند.
function pickTokens(user) {
  return [...new Set(((user && user.pushTokens) || []).filter((t) => typeof t === 'string' && t.trim()))];
}

function newLoginPushPayload({ session, chatId, messageId, userId }) {
  const device = String(session?.deviceName || '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'دستگاه ناشناس';
  return {
    title: 'ورود جدید به حساب',
    body: `${device} — اگر خودت نبودی، همین حالا بررسی کن`,
    // نوع «message» با chatId/messageId: لمسِ اعلان چتِ سیستمی را باز می‌کند و روی پیامِ هشدار (دکمه‌های «بله/نه») می‌پرد
    data: { type: 'message', kind: 'new_login', chatId: String(chatId), messageId: String(messageId), recipientId: String(userId) },
    sound: 'default',
  };
}

module.exports = { pickTokens, newLoginPushPayload };
