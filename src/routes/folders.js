const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  res.json(req.user.folders);
});

router.post('/', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'نام پوشه الزامی است' });
  req.user.folders.push({ name: name.trim(), chatIds: [] });
  await req.user.save();
  res.status(201).json(req.user.folders[req.user.folders.length - 1]);
});

router.delete('/:folderId', requireAuth, async (req, res) => {
  req.user.folders = req.user.folders.filter((f) => f._id.toString() !== req.params.folderId);
  await req.user.save();
  res.json({ ok: true });
});

// اضافه/حذف یک چت از یک پوشه (toggle)
router.post('/:folderId/toggle-chat', requireAuth, async (req, res) => {
  const { chatId } = req.body;
  const folder = req.user.folders.id(req.params.folderId);
  if (!folder) return res.status(404).json({ error: 'پوشه یافت نشد' });

  const idx = folder.chatIds.findIndex((id) => id.toString() === chatId);
  if (idx >= 0) folder.chatIds.splice(idx, 1);
  else folder.chatIds.push(chatId);

  await req.user.save();
  res.json({ ok: true, chatIds: folder.chatIds });
});

module.exports = router;
