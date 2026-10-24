// پیام‌های سرویسِ چت مخفی (مثل تلگرام): «X تایمر را روی … گذاشت» و «X اسکرین‌شات گرفت».
// فرستنده = کنشگر؛ متن در کلاینت و با زبانِ خودِ بیننده ساخته می‌شود (content خالی، مطلب در mediaMeta.action/ttlSeconds).
const Message = require('../models/Message');
const { serviceMediaMeta } = require('./secretPolicy');

async function postSecretService(io, chat, actorId, action, params) {
  const mediaMeta = serviceMediaMeta(action, params);
  if (!mediaMeta) return null;
  const message = await Message.create({ chat: chat._id, sender: actorId, type: 'system_action', content: '', mediaMeta });
  await message.populate('sender', 'username displayName avatarUrl');
  io?.to(`chat:${chat._id}`).emit('message:new', message.toObject());
  return message;
}

module.exports = { postSecretService };
