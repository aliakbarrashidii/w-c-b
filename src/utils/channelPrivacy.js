function anonymizeChannelSender(chat, obj) {
  if (!chat || chat.type !== 'channel' || chat.signMessages || !obj || !obj.sender || typeof obj.sender !== 'object' || Array.isArray(obj.sender)) return obj;
  obj.sender = { ...obj.sender, displayName: chat.title || '', username: '', avatarUrl: chat.avatarUrl || '' };
  return obj;
}

// «فوروارد از …»: نام فرستنده‌ی اصلی (فقط displayName) یا، اگر از کانال بوده، عنوان کانال. فرستنده‌ی پست کانال هرگز لو نمی‌رود
// (کانال‌های بدون امضا ناشناس‌اند). ورودی obj باید forwardedFrom.originalSender/originalChat را populate شده داشته باشد.
function shapeForwardedFrom(obj) {
  const ff = obj && obj.forwardedFrom;
  if (!ff) return obj;
  const chat = ff.originalChat && typeof ff.originalChat === 'object' ? ff.originalChat : null;
  const sender = ff.originalSender && typeof ff.originalSender === 'object' ? ff.originalSender : null;
  obj.forwardedFrom = {
    originalChat: chat ? { _id: chat._id, title: chat.title || '', type: chat.type } : null,
    originalSender: chat && chat.type === 'channel' ? null : (sender ? { _id: sender._id, displayName: sender.displayName || '' } : null),
  };
  return obj;
}

module.exports = { anonymizeChannelSender, shapeForwardedFrom };
