const express = require('express');
const { requireRole } = require('../middleware/auth');
const { canActOn, clampNumber } = require('../utils/adminGuards');
const User = require('../models/User');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const Report = require('../models/Report');
const EncryptedReport = require('../models/EncryptedReport');
const AdminLog = require('../models/AdminLog');
const { decryptText } = require('../utils/crypto');
const { updateSettings } = require('../utils/settings');
const { getPolicy, AI_CATEGORIES } = require('../utils/moderationPolicy');
const { FEATURES, activeRestrictions, addRestriction, notifyUser } = require('../utils/restrictions');

const router = express.Router();
const log = (adminId, action, note) => AdminLog.create({ admin: adminId, action, note }).catch(() => {});

// ---- سیاست نظارت (دو بخش + پلکان + جریمه گزارش‌دهنده) ----
router.get('/policy', async (req, res) => {
  const ModerationModel = require('../models/ModerationModel');
  const docs = await ModerationModel.find({}).select('labels');
  const categories = { ...AI_CATEGORIES };
  // کلاس‌هایی که تو مدل‌های آپلودشده هست (مثلاً کلاس ۵ که خودت اضافه کردی) خودکار تو سیاست ظاهر می‌شن
  for (const d of docs) for (const l of d.labels || []) if (l !== 'normal' && !categories[l]) categories[l] = l;
  res.json({ policy: await getPolicy(categories), categories, features: FEATURES });
});
router.put('/policy', requireRole('admin'), async (req, res) => { // فقط ادمین: سیاست نظارت = اثر روی همه‌ی کاربران
  const { scopes, escalation, falseReporter } = req.body;
  const patch = {};
  const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (scopes) {
    if (!isPlain(scopes)) return res.status(400).json({ error: 'scopes نامعتبر است' });
    const cleanScopes = {};
    for (const [k, v] of Object.entries(scopes)) if (/^[a-z0-9_]{1,40}$/i.test(k) && typeof v === 'boolean') cleanScopes[k] = v;
    patch['moderationPolicy.scopes'] = cleanScopes;
  }
  if (Array.isArray(escalation)) patch['moderationPolicy.escalation'] = escalation.slice(0, 20).map((e) => ({ confirmed: clampNumber(e?.confirmed, 1, 1000, 1), features: (Array.isArray(e?.features) ? e.features : []).filter((f) => FEATURES[f]), days: clampNumber(e?.days, 0, 3650, 0) }));
  if (falseReporter) {
    if (!isPlain(falseReporter)) return res.status(400).json({ error: 'falseReporter نامعتبر است' });
    patch['moderationPolicy.falseReporter'] = { ...falseReporter };
    for (const k of Object.keys(patch['moderationPolicy.falseReporter'])) {
      const v = patch['moderationPolicy.falseReporter'][k];
      if (typeof v === 'number') patch['moderationPolicy.falseReporter'][k] = clampNumber(v, 0, 3650, 0);
      else if (typeof v !== 'boolean' && !Array.isArray(v)) delete patch['moderationPolicy.falseReporter'][k];
    }
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'تغییری ارسال نشده' });
  await updateSettings(patch);
  await log(req.user.id, 'update_settings', 'moderation policy');
  res.json({ policy: await getPolicy() });
});

// ---- صفِ پرونده‌ها: گزارش‌های کاربر + گزارش‌های خودکارِ هوش مصنوعی، یکجا ----
router.get('/cases', async (req, res) => {
  const { status = 'pending' } = req.query;
  const [user, ai] = await Promise.all([
    Report.find({ status }).sort({ createdAt: -1 }).limit(100).populate('reporter', 'displayName username moderation').populate('targetUser', 'displayName username moderation').populate('chat', 'title type'),
    EncryptedReport.find({ status }).sort({ createdAt: -1 }).limit(100).populate('accusedUser', 'displayName username moderation'),
  ]);
  const items = [
    ...user.map((r) => ({ kind: 'user', id: r._id, createdAt: r.createdAt, category: r.category, description: r.description, reporter: r.reporter, accused: r.targetUser, status: r.status, targetType: r.targetType, chatTitle: r.targetType === 'chat' ? r.chat?.title || '' : undefined, hasSealed: !!r.sealedContext })),
    ...ai.map((r) => ({ kind: 'ai', id: r._id, createdAt: r.createdAt, category: r.category, accused: r.accusedUser, status: r.status, hasSealed: true })),
  ].sort((a, b) => b.createdAt - a.createdAt);
  res.json(items);
});

// جزئیات یه پرونده + کل چتِ قابل‌دسترس. چت‌های E2E: سرور فقط سایفرتکست داره؛ بافتِ واقعی فقط
// از sealedBox (با کلید خصوصی ادمین، سمت اپ باز می‌شه) میاد. چت‌های غیرE2E (مثل گروه‌های قدیمی): از خودِ سرور.
router.get('/cases/:kind/:id', async (req, res) => {
  const { kind, id } = req.params;
  const rec = kind === 'ai' ? await EncryptedReport.findById(id).populate('accusedUser', 'displayName username moderation restrictions') : await Report.findById(id).populate('reporter', 'displayName username moderation').populate('targetUser', 'displayName username moderation restrictions').populate('targetMessage');
  if (!rec) return res.status(404).json({ error: 'پرونده پیدا نشد' });
  const chatId = kind === 'ai' ? rec.chat : rec.chat || rec.targetMessage?.chat;
  let serverMessages = [];
  let members = [];
  if (chatId) {
    const chat = await Chat.findById(chatId).populate('members.user', 'displayName username');
    members = (chat?.members || []).map((m) => ({ id: m.user?._id, name: m.user?.displayName }));
    const msgs = await Message.find({ chat: chatId, deletedForEveryone: false, type: 'text' }).sort({ createdAt: -1 }).limit(200).populate('sender', 'displayName');
    serverMessages = msgs.reverse().map((m) => {
      const e2e = !!(m.e2e?.senderDeviceId || m.groupE2e?.ciphertext);
      return { id: m._id, sender: m.sender?.displayName, senderId: m.sender?._id, at: m.createdAt, e2e, text: e2e ? null : (chat.type === 'secret' ? m.content : decryptText(m.content)) };
    });
  }
  const accused = kind === 'ai' ? rec.accusedUser : rec.targetUser;
  res.json({
    kind, case: rec, members, serverMessages,
    sealedBox: kind === 'ai' ? rec.sealedBox : rec.sealedContext,
    activeRestrictions: accused ? activeRestrictions(accused) : [],
  });
});

// تصمیم: confirm (تأیید + محدودیت) | under_review (فقط زیر نظر) | dismiss (رد)
router.post('/cases/:kind/:id/decide', async (req, res) => {
  const { kind, id } = req.params;
  const { decision, accusedUserId, features: rawFeatures = [], days: rawDays = 0, reason: rawReason = '', notifyUser: doNotify = true, note: rawNote = '' } = req.body;
  const features = (Array.isArray(rawFeatures) ? rawFeatures : []).filter((f) => FEATURES[f]);
  const days = clampNumber(rawDays, 0, 3650, 0);
  const reason = String(rawReason || '').slice(0, 300);
  const note = String(rawNote || '').slice(0, 1000);
  if (!['confirm', 'under_review', 'dismiss'].includes(decision)) return res.status(400).json({ error: 'تصمیم نامعتبر' });
  const Model = kind === 'ai' ? EncryptedReport : Report;
  const rec = await Model.findById(id);
  if (!rec) return res.status(404).json({ error: 'پرونده پیدا نشد' });
  // هر پرونده فقط یک‌بار «نهایی» می‌شه: بدون این، دابل‌تپ یا دو ناظر هم‌زمان شمارنده‌ی تأییدشده/محدودیت/نردبان تشدید رو چندبار اعمال می‌کردن
  if (['confirmed', 'dismissed'].includes(rec.status)) return res.status(409).json({ error: 'این پرونده قبلاً نهایی شده است' });
  // متهمِ مشخص‌شده در پرونده تغییر نمی‌کنه؛ فقط وقتی متهمی ثبت نشده (گزارش گروه/کانال) مدیر می‌تونه انتخاب کنه و باید عضو همون چت باشه
  const recAccused = kind === 'ai' ? rec.accusedUser : rec.targetUser;
  let accusedId = recAccused;
  if (!recAccused && accusedUserId) {
    if (!rec.chat || !(await Chat.exists({ _id: rec.chat, 'members.user': accusedUserId }))) return res.status(400).json({ error: 'متهم باید عضو همان گروه/کانال باشد' });
    accusedId = accusedUserId;
  }
  if (accusedId) {
    const target = await User.findById(accusedId).select('role');
    if (!target) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    if (!canActOn(req.user.role, target.role)) return res.status(403).json({ error: 'اجازه‌ی این اقدام روی این حساب را ندارید' });
  }
  const policy = await getPolicy();
  const applied = [];

  if (decision === 'confirm') {
    if (!accusedId) return res.status(400).json({ error: 'متهم مشخص نیست' });
    const accused = await User.findByIdAndUpdate(accusedId, { $inc: { 'moderation.reportsAgainstConfirmed': 1, 'moderation.reportsAgainst': 0 }, $set: { 'moderation.underReview': false } }, { new: true });
    if (features.length) { const r = await addRestriction(accusedId, { features, days, reason, source: 'admin' }); if (r) applied.push({ features: r.features, until: r.until }); }
    // پلکانِ خودکار: بالاترین پله‌ای که تعدادش رسیده (فقط قابلیت‌هایی که الان فعال نیستن اضافه می‌شن)
    const step = [...policy.escalation].reverse().find((e) => accused.moderation.reportsAgainstConfirmed >= e.confirmed);
    if (step) {
      const already = new Set(activeRestrictions(accused).flatMap((r) => r.features));
      const fresh = step.features.filter((f) => !already.has(f) && !features.includes(f));
      if (fresh.length) { const r = await addRestriction(accusedId, { features: fresh, days: step.days, reason: reason || 'تکرار تخلف', source: 'auto' }); if (r) applied.push({ features: r.features, until: r.until, auto: true }); }
    }
    if (doNotify && applied.length) {
      const lines = applied.map((a) => `• ${a.features.map((f) => FEATURES[f]).join('، ')} — ${a.until ? 'تا ' + new Date(a.until).toLocaleDateString('fa-IR') : 'تا اطلاع ثانوی'}`).join('\n');
      await notifyUser(req.app, accusedId, `به‌خاطر گزارش بررسی‌شده${reason ? ` («${reason}»)` : ''}، این محدودیت‌ها روی حساب شما اعمال شد:\n${lines}`);
    }
  } else if (decision === 'under_review') {
    if (accusedId) await User.findByIdAndUpdate(accusedId, { $set: { 'moderation.underReview': true, 'moderation.reviewNote': note || reason } });
    if (doNotify && accusedId) await notifyUser(req.app, accusedId, 'گزارشی درباره‌ی حساب شما بررسی شد؛ فعلاً محدودیتی اعمال نمی‌شود، ولی رفتار حساب مدتی تحت نظر است.');
  }

  // آمار گزارش‌دهنده (فقط گزارش‌های کاربری): تأییدشده/ردشده، و جریمه‌ی گزارش‌دهنده‌ی الکی
  if (kind === 'user' && rec.reporter && decision !== 'under_review') {
    const field = decision === 'confirm' ? 'moderation.reportsFiledConfirmed' : 'moderation.reportsFiledRejected';
    const reporter = await User.findByIdAndUpdate(rec.reporter, { $inc: { [field]: 1 } }, { new: true });
    const fr = policy.falseReporter;
    const m = reporter.moderation;
    const total = m.reportsFiledConfirmed + m.reportsFiledRejected;
    if (decision === 'dismiss' && m.reportsFiledRejected >= fr.rejectedThreshold && m.reportsFiledRejected / Math.max(total, 1) >= fr.minRejectRatio) {
      const r = await addRestriction(reporter._id, { features: fr.features, days: fr.days, reason: 'ثبت مکرر گزارش‌های نادرست', source: 'auto' });
      if (r) await notifyUser(req.app, reporter._id, 'چون چند گزارش اخیرتان بررسی و نادرست تشخیص داده شد، ثبت گزارش برای مدتی غیرفعال شد.');
    }
  }

  rec.status = decision === 'confirm' ? 'confirmed' : decision === 'dismiss' ? 'dismissed' : 'under_review';
  rec.decision = { by: req.user.id, at: new Date(), decision, features, days, reason, note, applied };
  rec.reviewedBy = req.user.id;
  if (kind === 'ai') rec.reviewed = rec.status !== 'under_review'; else rec.resolved = rec.status !== 'under_review';
  await rec.save();
  await log(req.user.id, 'moderation_decision', `${kind}:${id} ${decision}`);
  res.json({ ok: true, applied });
});

// ---- پرونده‌ی هر کاربر + مدیریت دستیِ محدودیت‌ها (برای همه‌ی کاربرا، تک‌تک قابلیت‌ها) ----
router.get('/users/:id/moderation', async (req, res) => {
  const user = await User.findById(req.params.id).select('displayName username moderation restrictions status');
  if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  const [againstUser, againstAi] = await Promise.all([
    Report.countDocuments({ targetUser: user._id }),
    EncryptedReport.countDocuments({ accusedUser: user._id }),
  ]);
  res.json({ user, totals: { reportsAgainst: againstUser + againstAi, reportsAgainstConfirmed: user.moderation.reportsAgainstConfirmed, filed: user.moderation.reportsFiledConfirmed + user.moderation.reportsFiledRejected, filedRejected: user.moderation.reportsFiledRejected }, active: activeRestrictions(user), all: user.restrictions, features: FEATURES });
});
// ناظر فقط روی کاربر عادی عمل می‌کنه (روی ادمین/ناظر فقط ادمین)
async function assertTarget(req, res) {
  const target = await User.findById(req.params.id).select('role');
  if (!target) { res.status(404).json({ error: 'کاربر پیدا نشد' }); return false; }
  if (!canActOn(req.user.role, target.role)) { res.status(403).json({ error: 'اجازه‌ی این اقدام روی این حساب را ندارید' }); return false; }
  return true;
}
router.post('/users/:id/restrictions', async (req, res) => {
  if (!(await assertTarget(req, res))) return;
  const { features, notifyUser: doNotify } = req.body;
  const days = clampNumber(req.body?.days, 0, 3650, 0);
  const reason = String(req.body?.reason || '').slice(0, 300);
  const r = await addRestriction(req.params.id, { features, days, reason });
  if (!r) return res.status(400).json({ error: 'حداقل یک قابلیت انتخاب کن' });
  if (doNotify) await notifyUser(req.app, req.params.id, `این محدودیت‌ها روی حساب شما اعمال شد: ${r.features.map((f) => FEATURES[f]).join('، ')}${reason ? `\nدلیل: ${reason}` : ''}`);
  await log(req.user.id, 'restrict_user', `${req.params.id} ${r.features.join(',')}`);
  res.json({ ok: true });
});
router.delete('/users/:id/restrictions/:rid', async (req, res) => {
  if (!(await assertTarget(req, res))) return;
  await User.updateOne({ _id: req.params.id }, { $pull: { restrictions: { _id: req.params.rid } } });
  await log(req.user.id, 'lift_restriction', `${req.params.id} ${req.params.rid}`);
  res.json({ ok: true });
});
router.get('/watchlist', async (req, res) => res.json(await User.find({ 'moderation.underReview': true }).select('displayName username moderation')));
router.post('/users/:id/clear-watch', async (req, res) => { await User.updateOne({ _id: req.params.id }, { $set: { 'moderation.underReview': false } }); res.json({ ok: true }); });

module.exports = router;
