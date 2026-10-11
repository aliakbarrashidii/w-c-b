const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const SenderKeyDistribution = require('../models/SenderKeyDistribution');
const Chat = require('../models/Chat');

// سرور اینجا فقط یه بسته‌ی e2e (که با همون مکانیزم ۱به۱ X3DH+Double Ratchet رمز شده) رله می‌کنه؛
// خودِ سندرکی رو نمی‌بینه. اگه گیرنده آنلاین باشه فوراً می‌رسه، وگرنه تا اتصال بعدیش می‌مونه.
router.post('/senderkey/distribute', requireAuth, async (req, res) => {
  const { groupId, toUserId, e2e } = req.body;
  if (!groupId || !toUserId || !e2e?.payloads?.length) {
    return res.status(400).json({ error: 'اطلاعات توزیع سندرکی ناقص است' });
  }
  const chat = await Chat.findById(groupId).select('members type');
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'گروه یافت نشد' });
  const isMember = chat.members.some((m) => m.user.toString() === req.user._id.toString());
  if (!isMember) return res.status(403).json({ error: 'شما عضو این گروه نیستید' });

  // گیرنده هم باید عضو همین گروه باشه (قبلاً هر کاربری می‌تونست برای هر کاربرِ دیگه‌ای سند + رویداد سوکت بسازه = اسپم/پرکردنِ DB)؛
  // و اندازه‌ی payload محدوده
  if (!chat.members.some((m) => m.user.toString() === String(toUserId))) return res.status(400).json({ error: 'گیرنده عضو این گروه نیست' });
  if (JSON.stringify(e2e).length > 64 * 1024) return res.status(413).json({ error: 'حجم داده زیاد است' });

  const doc = await SenderKeyDistribution.create({ toUser: toUserId, fromUser: req.user._id, groupId, e2e });

  const io = req.app.get('io');
  io?.to(`user:${toUserId}`).emit('senderkey:distribution', {
    id: doc._id,
    groupId,
    fromUserId: req.user._id,
    e2e,
  });

  res.json({ ok: true });
});

// وقتی کلاینت یه توزیع رو با موفقیت پردازش کرد، از صف حذفش می‌کنه (جلوی پردازش تکراری رو می‌گیره)
router.post('/senderkey/ack/:id', requireAuth, async (req, res) => {
  await SenderKeyDistribution.deleteOne({ _id: req.params.id, toUser: req.user._id });
  res.json({ ok: true });
});

module.exports = router;
