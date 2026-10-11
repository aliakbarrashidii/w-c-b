// کانالِ بدون «امضای نویسنده» (Chat.signMessages=false): هویتِ ادمینِ فرستنده نباید به مشترک‌ها برسه. قبلاً فقط UI نام رو پنهان می‌کرد
// ولی API همه‌ی فیلدهای sender (نام، یوزرنیم، آواتار) رو می‌فرستاد. اینجا نام/یوزرنیم/آواتار با مشخصات خودِ کانال جایگزین می‌شن.
// `_id` عمداً می‌مونه (کلاینت برای «پیام خودم» و گروه‌بندی پیام‌ها لازمش داره)؛ پس ناشناس‌بودن در حد «پنهان‌کردن نام و تصویر» است، نه پنهان‌کردن شناسه.
function anonymizeChannelSender(chat, obj) {
  if (!chat || chat.type !== 'channel' || chat.signMessages || !obj || !obj.sender || typeof obj.sender !== 'object' || Array.isArray(obj.sender)) return obj;
  obj.sender = { ...obj.sender, displayName: chat.title || '', username: '', avatarUrl: chat.avatarUrl || '' };
  return obj;
}

module.exports = { anonymizeChannelSender };
