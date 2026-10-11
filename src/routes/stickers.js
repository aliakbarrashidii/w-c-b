const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { safeUploadName } = require('../utils/uploadName');
const StickerPack = require('../models/StickerPack');
const User = require('../models/User');
const { requireAuth, requireRole } = require('../middleware/auth');

const DIR = path.join(__dirname, '..', '..', 'uploads', 'stickers'); // جدا از uploads پیام‌ها: پاک‌سازیِ نگهداری بهش دست نمی‌زنه
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({ destination: (r, f, cb) => cb(null, DIR), filename: (r, f, cb) => { const n = safeUploadName(f.originalname); cb(null, n.includes('.') ? n : `${n}.png`); } }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (r, f, cb) => cb(null, /^image\/(png|webp|jpeg|gif)$/.test(f.mimetype)),
});
const urlFor = (req, file) => `${req.protocol}://${req.get('host')}/uploads/stickers/${file.filename}`;

// ---- بخش کاربر ----
const userRouter = express.Router();
userRouter.get('/packs', requireAuth, async (req, res) => {
  const packs = await StickerPack.find({ published: true }).sort({ order: 1, createdAt: -1 });
  const mine = new Set((req.user.stickerPacks || []).map(String));
  res.json(packs.map((p) => ({ id: p._id, title: p.title, iconUrl: p.iconUrl || p.stickers[0]?.url || '', count: p.stickers.length, preview: p.stickers.slice(0, 4).map((s) => s.url), added: mine.has(String(p._id)) || p.isDefault })));
});
userRouter.get('/mine', requireAuth, async (req, res) => {
  const defaults = await StickerPack.find({ published: true, isDefault: true }).select('_id');
  const ids = [...new Set([...defaults.map((d) => String(d._id)), ...(req.user.stickerPacks || []).map(String)])];
  const packs = await StickerPack.find({ _id: { $in: ids }, published: true }).sort({ order: 1 });
  res.json(packs.map((p) => ({ id: p._id, title: p.title, iconUrl: p.iconUrl || p.stickers[0]?.url || '', stickers: p.stickers.map((s) => ({ id: s._id, url: s.url, emoji: s.emoji })) })));
});
userRouter.post('/packs/:id/add', requireAuth, async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $addToSet: { stickerPacks: req.params.id } });
  res.json({ ok: true });
});
userRouter.delete('/packs/:id', requireAuth, async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $pull: { stickerPacks: req.params.id } });
  res.json({ ok: true });
});

// ---- بخش ادمین (زیر /api/admin/sticker-packs) ----
const adminRouter = express.Router();
adminRouter.get('/', async (req, res) => res.json(await StickerPack.find({}).sort({ order: 1, createdAt: -1 })));
adminRouter.post('/', async (req, res) => {
  if (!req.body.title?.trim()) return res.status(400).json({ error: 'نام پک الزامی است' });
  res.status(201).json(await StickerPack.create({ title: req.body.title.trim(), isDefault: !!req.body.isDefault }));
});
adminRouter.patch('/:id', async (req, res) => {
  const patch = {};
  for (const k of ['title', 'published', 'isDefault', 'order', 'iconUrl']) if (req.body[k] !== undefined) patch[k] = req.body[k];
  res.json(await StickerPack.findByIdAndUpdate(req.params.id, patch, { new: true }));
});
adminRouter.delete('/:id', async (req, res) => {
  await StickerPack.findByIdAndDelete(req.params.id);
  await User.updateMany({}, { $pull: { stickerPacks: req.params.id } });
  res.json({ ok: true });
});
adminRouter.post('/:id/stickers', upload.array('files', 40), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'تصویر معتبر (png/webp/jpg/gif تا ۲ مگابایت) ارسال نشد' });
  const pack = await StickerPack.findById(req.params.id);
  if (!pack) return res.status(404).json({ error: 'پک پیدا نشد' });
  const emoji = req.body.emoji || '🙂';
  files.forEach((f) => pack.stickers.push({ url: urlFor(req, f), emoji }));
  if (!pack.iconUrl) pack.iconUrl = pack.stickers[0].url;
  await pack.save();
  res.json(pack);
});
adminRouter.delete('/:id/stickers/:sid', async (req, res) => {
  const pack = await StickerPack.findById(req.params.id);
  pack.stickers = pack.stickers.filter((s) => String(s._id) !== req.params.sid);
  await pack.save();
  res.json(pack);
});

module.exports = { userRouter, adminRouter };
