const express = require('express');
const Activity = require('../models/Activity');
const { requireAuth } = require('../middleware/auth');
const { decryptText } = require('../utils/crypto');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const items = await Activity.find({ recipient: req.user._id })
    .sort({ createdAt: -1 })
    .limit(80)
    .populate('actor', 'username displayName avatarUrl')
    .populate('chat', 'type title')
    .populate('message', 'content type');

  const decrypted = items.map((it) => {
    const obj = it.toObject();
    if (obj.message?.content) obj.message.content = decryptText(obj.message.content);
    return obj;
  });

  res.json(decrypted);
});

router.post('/mark-all-read', requireAuth, async (req, res) => {
  await Activity.updateMany({ recipient: req.user._id, read: false }, { read: true });
  res.json({ ok: true });
});

module.exports = router;
