const { safePost } = require('./safeHttp');
const crypto = require('crypto');
const User = require('../models/User');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const Bot = require('../models/Bot');
const BotUpdate = require('../models/BotUpdate');
const { encryptText, decryptText } = require('./crypto');
const { getSettings } = require('./settings');
const { sendPushNotifications } = require('./push');

const DEFAULT_POLICY = { allowUserBots: true, maxBotsPerUser: 5, agentEnabled: true, agentRatePerMinPerUser: 6, agentDailyPerBot: 500, allowHttpEndpoints: false };
async function getBotPolicy() {
  const s = await getSettings();
  return { ...DEFAULT_POLICY, ...(s.botPolicy || {}) };
}

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const newToken = (botUserId) => `${botUserId}:${crypto.randomBytes(24).toString('hex')}`;

// جلوگیری از SSRF: آدرس‌های داخلی/لوکال برای webhook و endpoint عامل هوش مصنوعی مجاز نیستن
// (حمله‌ی DNS-rebinding رو پوشش نمی‌ده؛ برای پروداکشن بهتره سرور پشت فایروال خروجی باشه)
function isSafeUrl(raw, allowHttp) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h === '0.0.0.0' || h === '::1' || h.startsWith('[')) return false;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224) return false;
  }
  return true;
}

// آیدی‌های «انسانی»: ربات‌ها کلید رمزنگاری ندارن، پس از توزیع کلید گروه (Sender Key) کنار گذاشته می‌شن
async function humanIds(ids) {
  const bots = await User.find({ _id: { $in: ids }, isBot: true }).select('_id');
  const botSet = new Set(bots.map((b) => b._id.toString()));
  return ids.filter((id) => !botSet.has(String(id)));
}

// ---- ساخت پیام از طرف ربات (بدون E2E؛ شبیه پیام سیستمی) ----
async function postBotMessage(io, bot, chatId, { text, buttons, replyTo, media }) {
  const chat = await Chat.findById(chatId);
  if (!chat || !chat.members.some((m) => m.user.toString() === bot.user.toString())) throw new Error('ربات عضو این چت نیست');
  const clean = String(text || '').slice(0, 4000);
  if (!media && !clean.trim()) throw new Error('متن پیام خالیه');
  // ریپلای فقط به پیامِ همین چت (وگرنه صاحب ربات با reply_to_message_id می‌تونست محتوای رمزگشایی‌شده‌ی پیام هر چتی رو بخونه - IDOR)
  let safeReplyTo = null;
  if (replyTo) { try { safeReplyTo = (await Message.exists({ _id: replyTo, chat: chatId })) ? replyTo : null; } catch { safeReplyTo = null; } }
  const message = await Message.create({
    chat: chatId, sender: bot.user, type: media?.type || 'text', content: encryptText(clean), viaBot: true,
    ...(media ? { mediaUrl: media.mediaUrl, mediaMeta: media.mediaMeta } : {}),
    botMarkup: buttons ? { buttons } : undefined, replyTo: safeReplyTo,
  });
  await message.populate('sender', 'username displayName avatarUrl isBot');
  chat.lastMessage = message._id;
  chat.lastActivityAt = new Date();
  for (const m of chat.members) if (m.archived && m.user.toString() !== bot.user.toString() && !(m.mutedUntil && m.mutedUntil > new Date())) m.archived = false;
  await chat.save();
  const out = message.toObject();
  out.content = clean;
  io.to(`chat:${chatId}`).emit('message:new', out);
  // پوش برای اعضای آفلاین (best-effort)
  try {
    const others = chat.members.filter((m) => m.user.toString() !== bot.user.toString());
    const users = await User.find({ _id: { $in: others.map((m) => m.user) }, isOnline: false }).select('pushTokens notificationSettings');
    const botUser = await User.findById(bot.user).select('displayName');
    for (const u of users) {
      const st = u.notificationSettings || {};
      if (st.enabled === false) continue;
      sendPushNotifications(u.pushTokens, { title: botUser?.displayName || 'Bot', body: st.preview === false ? 'پیام جدید' : (clean.slice(0, 120) || { image: '📷', file: '📎', voice: '🎤' }[media?.type] || ''), sound: st.sound === false ? null : 'default', data: { chatId: String(chatId), type: 'message' } });
    }
  } catch {}
  Bot.updateOne({ _id: bot._id }, { $inc: { 'stats.messages': 1 }, $set: { 'stats.lastActiveAt': new Date() } }).catch(() => {});
  return out;
}

async function editBotMessage(io, bot, messageId, { text, buttons }) {
  const message = await Message.findById(messageId);
  if (!message || message.sender.toString() !== bot.user.toString()) throw new Error('پیام پیدا نشد');
  if (text !== undefined) { message.content = encryptText(String(text).slice(0, 4000)); message.editedAt = new Date(); }
  if (buttons !== undefined) message.botMarkup = buttons ? { buttons } : undefined;
  await message.save();
  io.to(`chat:${message.chat}`).emit('message:edited', { messageId, content: text !== undefined ? String(text).slice(0, 4000) : undefined, editedAt: message.editedAt, botMarkup: message.botMarkup || null });
  return message;
}

// ---- ساخت آپدیت و تحویل به ربات ----
const chatInfo = (chat) => ({ id: String(chat._id), type: chat.type, title: chat.title || '' });
const userInfo = (u) => ({ id: String(u._id), username: u.username, first_name: u.displayName, is_bot: false });

async function dispatchUpdate(io, bot, update) {
  if (!bot.active || bot.disabledByAdmin) return;
  const fresh = await Bot.findByIdAndUpdate(bot._id, { $inc: { nextUpdateId: 1 } }, { new: false });
  const full = { update_id: fresh.nextUpdateId, ...update };
  if (bot.type === 'commands') return handleCommandsBot(io, bot, full);
  if (bot.type === 'agent') return handleAgentBot(io, bot, full);
  // webhook: اگه آدرس داره POST، وگرنه تو صف می‌ره برای getUpdates
  const policy = await getBotPolicy();
  if (bot.webhookUrl && isSafeUrl(bot.webhookUrl, policy.allowHttpEndpoints)) {
    safePost(bot.webhookUrl, full, { timeout: 8000, headers: bot.webhookSecret ? { 'X-WizChat-Bot-Secret': bot.webhookSecret } : {} }).catch(() => {});
  } else {
    await BotUpdate.create({ bot: bot._id, updateId: full.update_id, payload: full });
  }
}

// پیام کاربر -> ربات‌هایی که باید بگیرن
async function onUserMessage(io, { chat, message, text, fromUser, botsOverride }) {
  const botUsers = botsOverride || (await User.find({ _id: { $in: chat.members.map((m) => m.user) }, isBot: true }).select('_id username displayName'));
  if (!botUsers.length) return;
  const bots = await Bot.find({ user: { $in: botUsers.map((b) => b._id) }, active: true, disabledByAdmin: false });
  const byUserId = Object.fromEntries(bots.map((b) => [b.user.toString(), b]));
  const unameById = Object.fromEntries(botUsers.map((b) => [b._id.toString(), b.username.toLowerCase()]));
  const isPrivate = chat.type === 'private';
  const lower = (text || '').toLowerCase();
  const cmd = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?/i.exec(text || '');

  // ریپلای به پیام ربات
  let repliedBotUserId = null;
  if (message.replyTo) {
    const r = await Message.findById(message.replyTo).select('sender viaBot');
    if (r?.viaBot) repliedBotUserId = r.sender.toString();
  }
  for (const bu of botUsers) {
    const bot = byUserId[bu._id.toString()];
    if (!bot) continue;
    const uname = unameById[bu._id.toString()];
    let deliver = isPrivate; // چت خصوصی با ربات: همه‌ی پیام‌ها
    if (!deliver && cmd) {
      if (cmd[2]) deliver = cmd[2].toLowerCase() === uname;
      else deliver = bot.type !== 'commands' || bot.commands.some((c) => c.command.toLowerCase() === cmd[1].toLowerCase()) || cmd[1].toLowerCase() === 'help' || cmd[1].toLowerCase() === 'start';
    }
    if (!deliver && lower.includes(`@${uname}`)) deliver = true;
    if (!deliver && repliedBotUserId === bu._id.toString()) deliver = true;
    if (!deliver) continue;
    await dispatchUpdate(io, bot, {
      message: {
        message_id: String(message._id), date: Math.floor(Date.now() / 1000), chat: chatInfo(chat), from: userInfo(fromUser),
        text, ...(message.replyTo ? { reply_to_message_id: String(message.replyTo) } : {}),
      },
    });
  }
}

// جواب دادن به کلیک دکمه (toast/alert): ربات با answerCallbackQuery جواب می‌ده؛ سرور باید بدونه این callback_query_id
// مال کدوم کاربر و کدوم ربات بود. فقط تو حافظه و ۶۰ ثانیه؛ هر callback فقط یک‌بار قابل جواب دادنه.
const pendingCallbacks = new Map();
function registerCallback(id, userId, botId) {
  const now = Date.now();
  for (const [k, v] of pendingCallbacks) if (v.expires < now) pendingCallbacks.delete(k);
  pendingCallbacks.set(id, { userId: String(userId), botId: String(botId), expires: now + 60000 });
}
function takeCallback(id, botId) {
  const v = pendingCallbacks.get(String(id));
  if (!v || v.expires < Date.now() || v.botId !== String(botId)) return null;
  pendingCallbacks.delete(String(id));
  return v;
}

async function onCallback(io, { chat, botMsg, fromUser, data }) {
  const bot = await Bot.findOne({ user: botMsg.sender, active: true, disabledByAdmin: false });
  if (!bot) return;
  const callbackId = crypto.randomBytes(6).toString('hex');
  registerCallback(callbackId, fromUser._id, bot._id);
  await dispatchUpdate(io, bot, {
    callback_query: { id: callbackId, from: userInfo(fromUser), data: String(data).slice(0, 64), message: { message_id: String(botMsg._id), chat: chatInfo(chat), text: decryptText(botMsg.content) } },
  });
}

// ---- ربات بدون‌کد: دستور => پاسخ + دکمه ----
async function handleCommandsBot(io, bot, upd) {
  const chatId = (upd.message || upd.callback_query?.message)?.chat.id;
  const replyTo = upd.message?.message_id || null;
  let name = null;
  let args = '';
  if (upd.callback_query) {
    const d = upd.callback_query.data || '';
    if (d.startsWith('cmd:')) name = d.slice(4);
    else return;
  } else {
    const m = /^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?\s*(.*)$/is.exec(upd.message.text || '');
    if (m) { name = m[1].toLowerCase(); args = m[2]; }
  }
  const userInfoRow = await User.findById(bot.user).select('displayName');
  let reply = null;
  if (name) {
    const c = bot.commands.find((x) => x.command.toLowerCase() === name);
    if (c) reply = { text: (c.reply || c.description || '…').replace(/\{args\}/g, args), buttons: c.buttons };
    else if (name === 'start') reply = { text: bot.description || `${userInfoRow?.displayName || ''}` || '👋' };
    else if (name === 'help') reply = { text: bot.commands.length ? bot.commands.map((x) => `/${x.command} — ${x.description || ''}`).join('\n') : (bot.description || '—') };
  }
  if (!reply && upd.message && upd.message.chat.type === 'private') reply = { text: bot.defaultReply || (bot.commands.length ? bot.commands.map((x) => `/${x.command} — ${x.description || ''}`).join('\n') : '…') };
  if (!reply) return;
  const out = await postBotMessage(io, bot, chatId, { text: reply.text, buttons: reply.buttons, replyTo });
  return out;
}

// ---- عامل هوش مصنوعی (LLM سازگار با OpenAI) ----
const BotMemory = require('../models/BotMemory'); // حافظه‌ی گفتگو الان تو DB است (قبلاً Map تو RAM)
const MEMORY_MAX = 40;
// const history = new Map(); // (قدیمی) `${botId}:${chatId}` -> [{role, content}] (فقط تو حافظه‌ی سرور؛ با ریستارت پاک می‌شه)
const rate = new Map(); // `${botId}:${userId}` -> [timestamps]
const daily = new Map(); // `${botId}:${yyyy-mm-dd}` -> count

// این دو Map قبلاً هیچ‌وقت خالی نمی‌شدن (نشت حافظه): کلیدهای منقضی رو گاه‌گاهی پاک می‌کنیم
function pruneAgentCounters(now) {
  if (rate.size > 2000) for (const [k, v] of rate) if (!v.some((t) => now - t < 60000)) rate.delete(k);
  if (daily.size > 500) { const today = new Date().toISOString().slice(0, 10); for (const k of daily.keys()) if (!k.endsWith(today)) daily.delete(k); }
}

async function handleAgentBot(io, bot, upd) {
  if (!upd.message?.text) return;
  const policy = await getBotPolicy();
  const chatId = upd.message.chat.id;
  const send = (text) => postBotMessage(io, bot, chatId, { text, replyTo: upd.message.message_id }).catch(() => {});
  if (!policy.agentEnabled) return send('⚠️ عامل‌های هوش مصنوعی فعلاً توسط مدیر سرور غیرفعال شده.');
  const a = bot.agent || {};
  if (!a.baseUrl || !a.model || !a.apiKeyEnc) return send('⚙️ این ربات هنوز تنظیم نشده (آدرس/مدل/کلید API).');
  if (!isSafeUrl(a.baseUrl, policy.allowHttpEndpoints)) return send('⚠️ آدرس سرویس هوش مصنوعی این ربات مجاز نیست.');
  const now = Date.now();
  pruneAgentCounters(now);
  const rk = `${bot._id}:${upd.message.from.id}`;
  const stamps = (rate.get(rk) || []).filter((t) => now - t < 60000);
  if (stamps.length >= policy.agentRatePerMinPerUser) return send('⏳ کمی آهسته‌تر؛ چند لحظه‌ی دیگه دوباره بپرس.');
  stamps.push(now); rate.set(rk, stamps);
  const dk = `${bot._id}:${new Date().toISOString().slice(0, 10)}`;
  const used = (daily.get(dk) || 0) + 1;
  if (used > policy.agentDailyPerBot) return send('⚠️ سقف پاسخ‌های روزانه‌ی این ربات پر شده.');
  daily.set(dk, used);

  // /reset یا /clear: پاک کردن حافظه‌ی گفتگو با این ربات (کنترل کاربر روی داده‌ش)
  if (/^\/(reset|clear)(@[a-z0-9_]+)?\s*$/i.test(upd.message.text.trim())) {
    await BotMemory.deleteOne({ bot: bot._id, chat: chatId });
    return send('🧹 حافظه‌ی این گفتگو پاک شد.');
  }
  const mem = await BotMemory.findOne({ bot: bot._id, chat: chatId }).lean();
  const hist = (mem?.messages || []).map((m) => { try { return { role: m.role, content: decryptText(m.content) }; } catch { return null; } }).filter(Boolean);
  const userText = upd.message.text.replace(/^\/[a-z0-9_]+(@[a-z0-9_]+)?\s*/i, '').trim() || upd.message.text;
  const botUser = await User.findById(bot.user).select('displayName username');
  const system = `${a.systemPrompt || 'You are a helpful assistant.'}\n\n(You are the bot "${botUser?.displayName}" inside the WizChat messenger. Keep replies concise. The user is ${upd.message.from.first_name}.)`;
  try {
    let key;
    try { key = decryptText(a.apiKeyEnc); } catch { return send('⚠️ کلید API معتبر نیست؛ دوباره تنظیمش کن.'); }
    const res = await safePost(`${a.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      model: a.model, temperature: a.temperature, max_tokens: 700,
      messages: [{ role: 'system', content: system }, ...hist.slice(-(a.maxHistory || 10) * 2), { role: 'user', content: userText }],
    }, { timeout: 45000, headers: { Authorization: `Bearer ${key}` } });
    const answer = res.data?.choices?.[0]?.message?.content?.trim();
    if (!answer) return send('🤔 جوابی دریافت نشد.');
    await BotMemory.updateOne(
      { bot: bot._id, chat: chatId },
      { $push: { messages: { $each: [{ role: 'user', content: encryptText(userText) }, { role: 'assistant', content: encryptText(answer) }], $slice: -MEMORY_MAX } }, $set: { updatedAt: new Date() } },
      { upsert: true }
    ).catch(() => {}); // خطای ذخیره‌ی حافظه نباید جواب کاربر رو خراب کنه
    return postBotMessage(io, bot, chatId, { text: answer, replyTo: upd.message.message_id });
  } catch (err) {
    const status = err.response?.status;
    return send(status === 401 || status === 403 ? '⚠️ کلید API رد شد.' : status === 429 ? '⚠️ سرویس هوش مصنوعی شلوغه، کمی بعد امتحان کن.' : '⚠️ خطا در ارتباط با سرویس هوش مصنوعی.');
  }
}

module.exports = { getBotPolicy, hashToken, newToken, isSafeUrl, humanIds, postBotMessage, editBotMessage, dispatchUpdate, onUserMessage, onCallback, DEFAULT_POLICY, takeCallback };
