const express = require('express');
const Bot = require('../models/Bot');
const BotUpdate = require('../models/BotUpdate');
const Message = require('../models/Message');
const User = require('../models/User');
const engine = require('../utils/botEngine');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { safeUploadName } = require('../utils/uploadName');
const { looksLikeImage, allowBotUpload } = require('../utils/botMedia');

// Bot API (شبیه تلگرام): POST/GET /bot-api/<token>/<method>   — بدنه JSON
// getMe, getUpdates, setWebhook, deleteWebhook, sendMessage, editMessageText, deleteMessage, setMyCommands, answerCallbackQuery
const router = express.Router();

const ok = (res, result) => res.json({ ok: true, result });
const fail = (res, code, description) => res.status(code).json({ ok: false, error_code: code, description });

// ---- ارسال فایل توسط ربات (sendPhoto / sendDocument / sendVoice) ----
// امن‌سازی: ۱) احراز هویت ربات «قبل از» ذخیره‌ی فایل (وگرنه هر کسی می‌تونست دیسک رو پر کنه)، ۲) فقط فایلِ آپلودشده تو multipart (فیلد «file»)
// - نه URL دلخواه (کلاینت‌ها اون URL رو لود می‌کردن = ردیابی IP)، ۳) نام تصادفی/پسوند امن، ۴) سقف ۲۰MB و ۶۰ آپلود/ساعت،
// ۵) برای عکس امضای واقعی فایل چک می‌شه.
const BOT_UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const MEDIA_TYPES = { sendPhoto: 'image', sendDocument: 'file', sendVoice: 'voice' };
const botUpload = multer({
  storage: multer.diskStorage({ destination: (r, f, cb) => cb(null, BOT_UPLOAD_DIR), filename: (r, f, cb) => cb(null, safeUploadName(f.originalname)) }),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});
async function botAuth(req, res, next) {
  const bot = await Bot.findOne({ tokenHash: engine.hashToken(req.params.token) });
  if (!bot) return fail(res, 401, 'Unauthorized');
  if (!bot.active || bot.disabledByAdmin) return fail(res, 403, 'Bot is disabled');
  if (!allowBotUpload(bot._id)) return fail(res, 429, 'Too many uploads; try again later');
  req.bot = bot;
  return next();
}
router.post('/:token/:method(sendPhoto|sendDocument|sendVoice)', botAuth, botUpload.single('file'), async (req, res) => {
  const file = req.file;
  const discard = () => { if (file) fs.promises.unlink(file.path).catch(() => {}); };
  try {
    const p = { ...req.query, ...req.body };
    if (!p.chat_id || !file) { discard(); return fail(res, 400, 'chat_id and a multipart "file" are required'); }
    const type = MEDIA_TYPES[req.params.method];
    if (type === 'image') {
      const head = Buffer.alloc(12);
      const fd = await fs.promises.open(file.path, 'r');
      try { await fd.read(head, 0, 12, 0); } finally { await fd.close(); }
      if (!looksLikeImage(head)) { discard(); return fail(res, 400, 'File is not a valid JPEG/PNG/GIF/WEBP image'); }
    }
    const mediaUrl = `${req.protocol}://${req.get('host')}/uploads/${file.filename}`;
    const out = await engine.postBotMessage(req.app.get('io'), req.bot, p.chat_id, {
      text: p.caption || '',
      buttons: normalizeButtons(p.buttons),
      replyTo: p.reply_to_message_id || null,
      media: { type, mediaUrl, mediaMeta: { fileName: String(file.originalname || '').slice(0, 120), fileSizeBytes: file.size, mimeType: String(file.mimetype || '').slice(0, 80) } },
    });
    return ok(res, { message_id: String(out._id), chat_id: String(out.chat), type });
  } catch (e) {
    discard();
    return fail(res, 400, e.message);
  }
});

router.all('/:token/:method', async (req, res) => {
  try {
    const bot = await Bot.findOne({ tokenHash: engine.hashToken(req.params.token) });
    if (!bot) return fail(res, 401, 'Unauthorized');
    if (!bot.active || bot.disabledByAdmin) return fail(res, 403, 'Bot is disabled');
    const io = req.app.get('io');
    const p = { ...req.query, ...req.body };
    const botUser = await User.findById(bot.user).select('username displayName');

    switch (req.params.method) {
      case 'getMe':
        return ok(res, { id: String(bot.user), username: botUser.username, first_name: botUser.displayName, is_bot: true, type: bot.type });

      case 'getUpdates': {
        const offset = Number(p.offset) || 0;
        const limit = Math.min(Number(p.limit) || 50, 100);
        const timeout = Math.min(Number(p.timeout) || 0, 25);
        // بلوغ تأییدشده‌ها پاک می‌شن (offset = آخرین update_id + 1)
        if (offset) await BotUpdate.deleteMany({ bot: bot._id, updateId: { $lt: offset } });
        const fetch = () => BotUpdate.find({ bot: bot._id, updateId: { $gte: offset } }).sort({ updateId: 1 }).limit(limit);
        let rows = await fetch();
        const start = Date.now();
        while (!rows.length && Date.now() - start < timeout * 1000) { // long-poll ساده
          await new Promise((r) => setTimeout(r, 1000));
          rows = await fetch();
        }
        return ok(res, rows.map((r) => r.payload));
      }

      case 'setWebhook': {
        const policy = await engine.getBotPolicy();
        if (p.url && !engine.isSafeUrl(p.url, policy.allowHttpEndpoints)) return fail(res, 400, 'Webhook URL must be a public https URL');
        bot.webhookUrl = p.url || '';
        bot.webhookSecret = p.secret || '';
        if (bot.type === 'commands' || bot.type === 'agent') bot.type = bot.type; // نوع تغییر نمی‌کنه؛ webhook فقط برای type=webhook مصرف می‌شه
        await bot.save();
        return ok(res, true);
      }
      case 'deleteWebhook':
        bot.webhookUrl = '';
        await bot.save();
        return ok(res, true);

      case 'setMyCommands': {
        const list = Array.isArray(p.commands) ? p.commands : [];
        const clean = list.slice(0, 50).map((c) => ({ command: String(c.command || '').replace(/^\//, '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32), description: String(c.description || '').slice(0, 100), reply: bot.type === 'commands' ? String(c.reply || '').slice(0, 2000) : '' })).filter((c) => c.command);
        bot.commands = clean;
        await bot.save();
        return ok(res, true);
      }

      case 'sendMessage': {
        if (!p.chat_id || !p.text) return fail(res, 400, 'chat_id and text are required');
        const out = await engine.postBotMessage(io, bot, p.chat_id, { text: p.text, buttons: normalizeButtons(p.buttons), replyTo: p.reply_to_message_id || null });
        return ok(res, { message_id: String(out._id), chat_id: String(out.chat), text: out.content });
      }
      case 'editMessageText': {
        if (!p.message_id) return fail(res, 400, 'message_id is required');
        await engine.editBotMessage(io, bot, p.message_id, { text: p.text, buttons: p.buttons !== undefined ? normalizeButtons(p.buttons) : undefined });
        return ok(res, true);
      }
      case 'deleteMessage': {
        const m = await Message.findById(p.message_id);
        if (!m || m.sender.toString() !== bot.user.toString()) return fail(res, 404, 'Message not found');
        m.deletedForEveryone = true; m.content = '';
        await m.save();
        await require('../utils/dataCleanup').unpinMessages([m._id]);
        io.to(`chat:${m.chat}`).emit('message:deleted', { messageId: String(m._id), forEveryone: true });
        return ok(res, true);
      }
      case 'answerCallbackQuery': {
        // toast (پیش‌فرض) یا پنجره‌ی هشدار (show_alert) فقط برای همون کاربری که دکمه رو زد
        const pending = p.callback_query_id ? engine.takeCallback(p.callback_query_id, bot._id) : null;
        if (!pending) return fail(res, 400, 'callback_query_id is invalid or expired');
        const text = String(p.text || '').slice(0, 200);
        if (text) io.to(`user:${pending.userId}`).emit('bot:answer', { text, alert: p.show_alert === true || p.show_alert === 'true', botName: botUser.displayName });
        return ok(res, true);
      }
      default:
        return fail(res, 404, 'Method not found');
    }
  } catch (err) {
    return fail(res, 400, err.message || 'Bad request');
  }
});

// ردیف‌های دکمه: [[{text, callback_data|url}]] با محدودیت اندازه
function normalizeButtons(b) {
  if (!Array.isArray(b)) return undefined;
  // دکمه‌ی لینک فقط http(s): کلاینت با Linking.openURL بازش می‌کنه؛ بدون این، ربات می‌تونست tel:/sms:/intent:/دیپ‌لینک اپ‌های دیگه
  // (یا file:/content:) بذاره. لینک نامعتبر = دکمه حذف می‌شه (نه تبدیل به callback).
  const safeUrl = (u) => (/^https?:\/\/[^\s]{1,490}$/i.test(String(u)) ? String(u) : null);
  const rows = b.slice(0, 8).map((row) => (Array.isArray(row) ? row : [row]).slice(0, 4).map((x) => {
    const text = String(x?.text || '').slice(0, 40);
    if (x?.url) { const url = safeUrl(x.url); return url ? { text, url } : { text: '' }; }
    return { text, callback_data: String(x?.callback_data || '').slice(0, 64) };
  }).filter((x) => x.text));
  return rows.filter((r) => r.length);
}
router.normalizeButtons = normalizeButtons;

module.exports = router;
