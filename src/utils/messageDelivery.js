const Message = require('../models/Message');

// بعد از هر جایی که به deliveredTo یه پیام چیزی اضافه می‌شه، این تابع چک می‌کنه که آیا
// حالا به همه‌ی اعضای چت (به‌جز فرستنده) رسیده یا نه؛ اگه آره fullyDeliveredAt رو ست می‌کنه
// تا شمارش‌معکوس نگهداری روی سرور (Settings.messageRetentionSec) از همون لحظه شروع بشه.
async function markFullyDelivered(chat, messageIds) {
  if (!messageIds?.length) return;
  const memberIds = chat.members.map((m) => m.user.toString());

  const messages = await Message.find({ _id: { $in: messageIds }, fullyDeliveredAt: null }).select(
    'sender deliveredTo'
  );
  if (!messages.length) return;

  const bulkOps = [];
  for (const msg of messages) {
    const required = memberIds.filter((id) => id !== msg.sender.toString());
    if (!required.length) continue; // چت بدون گیرنده‌ی دیگه (نباید پیش بیاد، ولی برای اطمینان)
    const deliveredIds = new Set(msg.deliveredTo.map((d) => d.user.toString()));
    const isComplete = required.every((id) => deliveredIds.has(id));
    if (!isComplete) continue;
    const lastDeliveredAt = msg.deliveredTo.reduce(
      (max, d) => (d.deliveredAt > max ? d.deliveredAt : max),
      new Date(0)
    );
    bulkOps.push({ updateOne: { filter: { _id: msg._id }, update: { fullyDeliveredAt: lastDeliveredAt } } });
  }
  if (bulkOps.length) await Message.bulkWrite(bulkOps);
}

module.exports = { markFullyDelivered };
