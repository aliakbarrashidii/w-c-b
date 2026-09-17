const express = require('express');
const Report = require('../models/Report');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/', requireAuth, async (req, res) => {
  const { targetType, targetUserId, targetMessageId, category, description } = req.body;
  if (!['user', 'message'].includes(targetType)) return res.status(400).json({ error: 'نوع گزارش نامعتبر است' });
  if (!category) return res.status(400).json({ error: 'دسته‌بندی الزامی است' });

  const report = await Report.create({
    reporter: req.user._id,
    targetType,
    targetUser: targetType === 'user' ? targetUserId : null,
    targetMessage: targetType === 'message' ? targetMessageId : null,
    category,
    description: description || '',
  });
  res.status(201).json({ ok: true, id: report._id });
});

module.exports = router;
