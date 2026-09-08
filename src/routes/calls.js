const express = require('express');
const CallLog = require('../models/CallLog');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// تاریخچه تماس‌های خودِ کاربر (نه همه‌ی سیستم — اون فقط تو پنل ادمینه)
router.get('/', requireAuth, async (req, res) => {
  const calls = await CallLog.find({
    $or: [{ caller: req.user._id }, { callee: req.user._id }],
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate('caller', 'username displayName avatarUrl')
    .populate('callee', 'username displayName avatarUrl');

  res.json(
    calls.map((c) => ({
      ...c.toObject(),
      isOutgoing: c.caller._id.toString() === req.user._id.toString(),
    }))
  );
});

module.exports = router;
