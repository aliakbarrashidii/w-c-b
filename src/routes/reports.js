const express = require('express');
const Report = require('../models/Report');
const mongoose = require('mongoose');
const Message = require('../models/Message');
const { requireAuth } = require('../middleware/auth');
const { guard } = require('../utils/restrictions');

const router = express.Router();

router.post('/', requireAuth, async (req, res) => {
  const { targetType, targetUserId, targetMessageId, category, description, chatId, sealedContext } = req.body;
  if (!['user', 'message', 'chat'].includes(targetType)) return res.status(400).json({ error: 'نوع گزارش نامعتبر است' });
  if (!category) return res.status(400).json({ error: 'دسته‌بندی الزامی است' });
  const blocked = await guard(req.user, 'file_reports');
  if (blocked) return res.status(403).json({ error: blocked });

  // گزارش پیام: متهم = فرستنده‌ی پیام، و چت از خودِ پیام پیدا می‌شه (نه ادعای کلاینت)
  let accused = targetType === 'user' ? targetUserId : null;
  let chat = null;
  if (targetType === 'message') {
    const msg = mongoose.isValidObjectId(targetMessageId) ? await Message.findById(targetMessageId).select('sender chat') : null;
    if (!msg) return res.status(404).json({ error: 'پیام پیدا نشد' });
    // فقط اعضای همون چت می‌تونن پیامش رو گزارش کنن؛ وگرنه هر کسی با دونستن messageId می‌تونست شمارنده‌ی «گزارش علیه کاربر»ِ فرستنده رو
    // بالا ببره (ابزار آزار/محدودسازی ناعادلانه‌ی خودکار)
    if (!(await require('../models/Chat').exists({ _id: msg.chat, 'members.user': req.user._id }))) return res.status(403).json({ error: 'دسترسی ندارید' });
    accused = msg.sender; chat = msg.chat;
  } else if (chatId) chat = chatId;
  // گزارش خودِ گروه/کانال: متهم مشخص نیست (ادمین موقع تصمیم، مالک/ادمین مسئول رو انتخاب می‌کنه) و شمارنده‌ی «گزارش علیه کاربر» زیاد نمی‌شه
  if (targetType === 'chat') {
    const Chat = require('../models/Chat');
    const target = chatId && (await Chat.findById(chatId).select('type members.user publicUsername'));
    if (!target || !['group', 'channel'].includes(target.type)) return res.status(404).json({ error: 'گروه یا کانال پیدا نشد' });
    const isMember = target.members.some((m) => String(m.user) === String(req.user._id));
    if (!isMember && !target.publicUsername) return res.status(403).json({ error: 'دسترسی ندارید' });
    const dup = await Report.findOne({ reporter: req.user._id, targetType: 'chat', chat: target._id, status: { $in: ['pending', 'under_review'] } }).select('_id');
    if (dup) return res.status(409).json({ error: 'این گروه را قبلاً گزارش کرده‌اید و در حال بررسی است' });
    const created = await Report.create({ reporter: req.user._id, targetType: 'chat', category, description: description || '', chat: target._id });
    return res.status(201).json({ ok: true, id: created._id });
  }
  if (accused && String(accused) === String(req.user._id)) return res.status(400).json({ error: 'نمی‌تونی خودت رو گزارش کنی' });

  // هر کاربر تا پایان بررسی فقط یک گزارش باز برای هر هدف (پیام/کاربر) داره - جلوگیری از گزارش‌های تکراری و سیل‌آسا
  const dupFilter = { reporter: req.user._id, targetType, status: { $in: ['pending', 'under_review'] } };
  if (targetType === 'message') dupFilter.targetMessage = targetMessageId; else dupFilter.targetUser = accused;
  if (await Report.exists(dupFilter)) return res.status(409).json({ error: 'این مورد را قبلاً گزارش کرده‌اید و در حال بررسی است' });

  const report = await Report.create({
    reporter: req.user._id,
    targetType,
    targetUser: accused || null,
    targetMessage: targetType === 'message' ? targetMessageId : null,
    category,
    description: description || '',
    chat,
    sealedContext: sealedContext?.ciphertext ? sealedContext : null, // بافتِ رمزشده‌ی چت‌های E2E (فقط با کلید ادمین باز می‌شه)
  });
  if (accused) await require('../models/User').updateOne({ _id: accused }, { $inc: { 'moderation.reportsAgainst': 1 } });
  res.status(201).json({ ok: true, id: report._id });
});

module.exports = router;
