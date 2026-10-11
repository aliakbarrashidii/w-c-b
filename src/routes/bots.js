const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Chat = require('../models/Chat');
const Bot = require('../models/Bot');
const { requireAuth } = require('../middleware/auth');
const { encryptText } = require('../utils/crypto');
const engine = require('../utils/botEngine');
const { normalizeButtons } = require('./botApi');

// مدیریت ربات‌ها توسط صاحبشون (شبیه BotFather): ساخت، ویرایش، توکن، حذف
const router = express.Router();
router.use(requireAuth);

const publicBot = (b, u) => ({
  id: b._id, userId: String(b.user), username: u?.username, name: u?.displayName, avatarUrl: u?.avatarUrl, type: b.type, description: b.description, active: b.active,
  disabledByAdmin: b.disabledByAdmin, commands: b.commands, defaultReply: b.defaultReply, webhookUrl: b.webhookUrl, hasWebhookSecret: !!b.webhookSecret,
  agent: { baseUrl: b.agent?.baseUrl || '', model: b.agent?.model || '', systemPrompt: b.agent?.systemPrompt || '', temperature: b.agent?.temperature ?? 0.7, maxHistory: b.agent?.maxHistory ?? 10, hasKey: !!b.agent?.apiKeyEnc },
  stats: b.stats,
});

router.get('/mine', async (req, res) => {
  const bots = await Bot.find({ owner: req.user._id }).sort({ createdAt: -1 });
  const users = await User.find({ _id: { $in: bots.map((b) => b.user) } }).select('username displayName avatarUrl');
  const byId = Object.fromEntries(users.map((u) => [u._id.toString(), u]));
  res.json(bots.map((b) => publicBot(b, byId[b.user.toString()])));
});

router.post('/', async (req, res) => {
  const policy = await engine.getBotPolicy();
  if (!policy.allowUserBots && req.user.role !== 'admin') return res.status(403).json({ error: 'ساخت ربات توسط مدیر سرور بسته شده' });
  const count = await Bot.countDocuments({ owner: req.user._id });
  if (count >= policy.maxBotsPerUser && req.user.role !== 'admin') return res.status(403).json({ error: `حداکثر ${policy.maxBotsPerUser} ربات می‌تونی بسازی` });
  const { name, username, description = '', type = 'commands' } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'اسم ربات الزامی است' });
  const uname = String(username || '').trim().toLowerCase().replace(/^@/, '');
  if (!/^[a-z][a-z0-9_]{2,28}bot$/.test(uname)) return res.status(400).json({ error: 'آیدی ربات باید با «bot» تموم بشه (فقط حروف انگلیسی، عدد و _)، مثلاً weather_bot' });
  if (!['commands', 'webhook', 'agent'].includes(type)) return res.status(400).json({ error: 'نوع نامعتبر' });
  if (await User.findOne({ username: uname })) return res.status(409).json({ error: 'این آیدی قبلاً گرفته شده' });
  const user = await User.create({ username: uname, displayName: name.trim().slice(0, 40), passwordHash: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 8), isBot: true, botOwner: req.user._id, bio: description.slice(0, 300), status: 'active' });
  const token = engine.newToken(user._id);
  const bot = await Bot.create({ user: user._id, owner: req.user._id, tokenHash: engine.hashToken(token), type, description: description.slice(0, 300) });
  res.status(201).json({ bot: publicBot(bot, user), token }); // توکن فقط همین یک‌بار نشان داده می‌شود
});

async function ownBot(req, res) {
  const bot = await Bot.findById(req.params.id);
  if (!bot || (bot.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin')) { res.status(404).json({ error: 'ربات پیدا نشد' }); return null; }
  return bot;
}

router.patch('/:id', async (req, res) => {
  const bot = await ownBot(req, res);
  if (!bot) return;
  const policy = await engine.getBotPolicy();
  const b = req.body;
  const userPatch = {};
  if (typeof b.name === 'string' && b.name.trim()) userPatch.displayName = b.name.trim().slice(0, 40);
  // آواتار فقط از آپلودهای خودمون (یا خالی): قبلاً هر URL بیرونی قبول می‌شد و کلاینت‌های همه‌ی کاربران اون رو لود می‌کردن = ردیابی IP
  // کاربرها / محتوای دلخواه. اینجا فقط /uploads/ خودمون مجازه.
  if (typeof b.avatarUrl === 'string') {
    if (b.avatarUrl && !require('../utils/dataCleanup').uploadPathFromUrl(b.avatarUrl)) return res.status(400).json({ error: 'آواتار باید از فایل‌های آپلودشده باشد' });
    userPatch.avatarUrl = b.avatarUrl;
  }
  if (typeof b.description === 'string') { bot.description = b.description.slice(0, 300); userPatch.bio = bot.description; }
  if (typeof b.active === 'boolean') bot.active = b.active;
  if (b.type && ['commands', 'webhook', 'agent'].includes(b.type)) bot.type = b.type;
  if (typeof b.defaultReply === 'string') bot.defaultReply = b.defaultReply.slice(0, 2000);
  if (Array.isArray(b.commands)) {
    bot.commands = b.commands.slice(0, 50).map((c) => ({
      command: String(c.command || '').replace(/^\//, '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32), description: String(c.description || '').slice(0, 100),
      reply: String(c.reply || '').slice(0, 2000), buttons: normalizeButtons(c.buttons),
    })).filter((c) => c.command);
  }
  if (typeof b.webhookUrl === 'string') {
    if (b.webhookUrl && !engine.isSafeUrl(b.webhookUrl, policy.allowHttpEndpoints)) return res.status(400).json({ error: 'آدرس webhook باید https و عمومی باشه' });
    bot.webhookUrl = b.webhookUrl;
  }
  if (typeof b.webhookSecret === 'string') bot.webhookSecret = b.webhookSecret.slice(0, 100);
  if (b.agent && typeof b.agent === 'object') {
    const a = b.agent;
    if (typeof a.baseUrl === 'string') {
      if (a.baseUrl && !engine.isSafeUrl(a.baseUrl, policy.allowHttpEndpoints)) return res.status(400).json({ error: 'آدرس سرویس هوش مصنوعی باید https و عمومی باشه' });
      bot.agent.baseUrl = a.baseUrl;
    }
    if (typeof a.model === 'string') bot.agent.model = a.model.slice(0, 100);
    if (typeof a.systemPrompt === 'string') bot.agent.systemPrompt = a.systemPrompt.slice(0, 4000);
    if (a.temperature !== undefined) bot.agent.temperature = Math.max(0, Math.min(Number(a.temperature) || 0, 2));
    if (a.maxHistory !== undefined) bot.agent.maxHistory = Math.max(0, Math.min(Number(a.maxHistory) || 0, 30));
    if (typeof a.apiKey === 'string' && a.apiKey.trim()) bot.agent.apiKeyEnc = encryptText(a.apiKey.trim());
    if (a.clearKey) bot.agent.apiKeyEnc = '';
  }
  await bot.save();
  if (Object.keys(userPatch).length) await User.updateOne({ _id: bot.user }, userPatch);
  const u = await User.findById(bot.user).select('username displayName avatarUrl');
  res.json(publicBot(bot, u));
});

router.post('/:id/revoke-token', async (req, res) => {
  const bot = await ownBot(req, res);
  if (!bot) return;
  const token = engine.newToken(bot.user);
  bot.tokenHash = engine.hashToken(token);
  await bot.save();
  res.json({ token });
});

router.delete('/:id', async (req, res) => {
  const bot = await ownBot(req, res);
  if (!bot) return;
  // حذف کامل: ربات، حساب ربات، حافظه‌ی AI، صف آپدیت‌ها، و چت‌های خصوصی کاربران با این ربات (utils/dataCleanup.js)
  await require('../utils/dataCleanup').purgeBot(bot);
  res.json({ ok: true });
});

// دستورهای ربات‌های عضوِ یه چت (برای پیشنهاد خودکار وقتی کاربر «/» می‌زنه)
router.get('/commands', async (req, res) => {
  const chat = await Chat.findById(req.query.chatId).select('members');
  if (!chat || !chat.members.some((m) => m.user.toString() === req.user._id.toString())) return res.status(403).json({ error: 'عضو نیستی' });
  const bots = await Bot.find({ user: { $in: chat.members.map((m) => m.user) }, active: true, disabledByAdmin: false }).select('user commands type description');
  const users = await User.find({ _id: { $in: bots.map((b) => b.user) } }).select('username displayName');
  const byId = Object.fromEntries(users.map((u) => [u._id.toString(), u]));
  res.json(bots.map((b) => ({ botId: String(b.user), username: byId[b.user.toString()]?.username, name: byId[b.user.toString()]?.displayName, type: b.type, commands: b.commands.map((c) => ({ command: c.command, description: c.description })) })));
});

module.exports = router;
