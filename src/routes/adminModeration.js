const express = require('express');
const mongoose = require('mongoose');
const { clampNumber } = require('../utils/adminGuards');
const User = require('../models/User');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const Report = require('../models/Report');
const EncryptedReport = require('../models/EncryptedReport');
const AdminLog = require('../models/AdminLog');
const { decryptText } = require('../utils/crypto');
const { updateSettings } = require('../utils/settings');
const { getPolicy, AI_CATEGORIES, sanitizeScopes } = require('../utils/moderationPolicy');
const { planLadder, freshApplications, higherStep } = require('../utils/ladder');
const { FEATURES, activeRestrictions, addRestriction, notifyUser } = require('../utils/restrictions');
const { loadStaff, requirePerm } = require('../middleware/staff');
const SP = require('../utils/staffPolicy');
const { sealedFor } = require('../utils/sealedBoxValidate');
const { escalate, board, activeStaff, OPEN } = require('../utils/caseRouting');
const { userCaseStats, confirmedCount } = require('../utils/caseStats');
const TrainingSample = require('../models/TrainingSample');
const { runCalibration } = require('../utils/trainingJobs');

const router = express.Router();
router.use(loadStaff);
const log = (adminId, action, note) => AdminLog.create({ admin: adminId, action, note }).catch(() => {});
const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);
const B64URL = /^[A-Za-z0-9+/_-]+={0,2}$/;
const modelOf = (kind) => (kind === 'ai' ? EncryptedReport : kind === 'user' ? Report : null);
const accusedOf = (kind, rec) => (kind === 'ai' ? rec.accusedUser : rec.targetUser);
const idOf = (v) => String(v?._id || v || '');

// ---------- سیاست نظارت ----------
router.get('/policy', async (req, res) => {
  const ModerationModel = require('../models/ModerationModel');
  const docs = await ModerationModel.find({}).select('labels');
  const categories = { ...AI_CATEGORIES };
  for (const d of docs) for (const l of d.labels || []) if (l !== 'normal' && !categories[l]) categories[l] = l;
  res.json({ policy: await getPolicy(categories), categories, features: FEATURES });
});
router.put('/policy', requirePerm('policy.edit'), async (req, res) => {
  const { scopes, escalation, falseReporter, watch, serious, dedupeMinutes, training } = req.body;
  const patch = {};
  if (scopes) {
    if (!isPlain(scopes)) return res.status(400).json({ error: 'scopes نامعتبر است' });
    patch['moderationPolicy.scopes'] = sanitizeScopes(scopes); // {private|group: {دسته: {enabled, minConfidence}}} (قبلاً همه‌چیز دور ریخته می‌شد)
  }
  if (serious !== undefined) {
    if (!Array.isArray(serious)) return res.status(400).json({ error: 'serious نامعتبر است' });
    patch['moderationPolicy.serious'] = [...new Set(serious.filter((c) => typeof c === 'string' && /^[a-z0-9_]{1,40}$/i.test(c)))].slice(0, 30);
  }
  if (dedupeMinutes !== undefined) patch['moderationPolicy.dedupeMinutes'] = clampNumber(dedupeMinutes, 0, 1440, 60);
  if (training !== undefined) {
    if (!isPlain(training)) return res.status(400).json({ error: 'training نامعتبر است' });
    const cur = (await getPolicy()).training;
    patch['moderationPolicy.training'] = {
      enabled: typeof training.enabled === 'boolean' ? training.enabled : cur.enabled,
      autoCalibrate: typeof training.autoCalibrate === 'boolean' ? training.autoCalibrate : cur.autoCalibrate,
      retentionDays: clampNumber(training.retentionDays ?? cur.retentionDays, 1, 3650, 365),
      targetPrecision: Math.min(0.99, Math.max(0.5, Number(training.targetPrecision ?? cur.targetPrecision) || 0.8)),
      minSamples: clampNumber(training.minSamples ?? cur.minSamples, 10, 100000, 30),
    };
  }
  if (Array.isArray(escalation)) {
    patch['moderationPolicy.escalation'] = escalation.slice(0, 60).map((e) => {
      const step = { confirmed: clampNumber(e?.confirmed, 1, 1000, 1), features: (Array.isArray(e?.features) ? e.features : []).filter((f) => FEATURES[f]), days: clampNumber(e?.days, 0, 3650, 0) };
      if (typeof e?.category === 'string' && /^[a-z0-9_]{1,40}$/i.test(e.category)) step.category = e.category; // پله‌ی مخصوصِ یک دسته
      return step;
    });
  }
  if (falseReporter) {
    if (!isPlain(falseReporter)) return res.status(400).json({ error: 'falseReporter نامعتبر است' });
    const fr = { ...falseReporter };
    for (const k of Object.keys(fr)) {
      if (typeof fr[k] === 'number') fr[k] = clampNumber(fr[k], 0, 3650, 0);
      else if (typeof fr[k] !== 'boolean' && !Array.isArray(fr[k])) delete fr[k];
    }
    patch['moderationPolicy.falseReporter'] = fr;
  }
  if (watch !== undefined) {
    if (!isPlain(watch)) return res.status(400).json({ error: 'watch نامعتبر است' });
    patch['moderationPolicy.watch'] = { reports: clampNumber(watch.reports, 0, 1000, 5), days: clampNumber(watch.days, 1, 3650, 30) };
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'تغییری ارسال نشده' });
  await updateSettings(patch);
  await log(req.user.id, 'update_settings', 'moderation policy');
  res.json({ policy: await getPolicy() });
});

// ---------- صف پرونده‌ها ----------
router.get('/cases', async (req, res) => {
  const status = ['pending', 'under_review', 'confirmed', 'dismissed'].includes(req.query.status) ? req.query.status : 'pending';
  const scope = SP.caseListFilter(req.user, req.staff.tiers);
  const base = { status, ...(scope || {}) };
  const showReporter = req.staff.window.full;
  const [user, ai] = await Promise.all([
    Report.find(base).sort({ createdAt: -1 }).limit(100).populate('reporter', 'displayName username moderation').populate('targetUser', 'displayName username moderation').populate('chat', 'title type').populate('assignedTo', 'displayName username'),
    EncryptedReport.find(base).sort({ createdAt: -1 }).limit(100).populate('accusedUser', 'displayName username moderation').populate('assignedTo', 'displayName username').populate(showReporter ? 'reporter' : '', 'displayName username'),
  ]);
  const routing = (r) => ({ tier: r.tier ?? 0, assignedTo: r.assignedTo || null, dueAt: r.dueAt || null, escalated: (r.escalations || []).length });
  const items = [
    ...user.map((r) => ({ kind: 'user', id: r._id, createdAt: r.createdAt, category: r.category, description: r.description, reporter: r.reporter, accused: r.targetUser, status: r.status, targetType: r.targetType, chatTitle: r.targetType === 'chat' ? r.chat?.title || '' : undefined, hasSealed: !!r.sealedContext, ...routing(r) })),
    ...ai.map((r) => ({ kind: 'ai', id: r._id, createdAt: r.createdAt, category: r.category, dupCount: r.dupCount || 0, accused: r.accusedUser, reporter: showReporter ? r.reporter : undefined, status: r.status, hasSealed: true, ...routing(r) })),
  ].sort((a, b) => b.createdAt - a.createdAt);
  res.json(items);
});

// پنجره‌ی بافتِ سرور (فقط چت‌های غیرE2E؛ E2E ها text:null هستند). full ⇒ تا ۲۰۰ پیامِ آخر؛ وگرنه n قبل و بعدِ نقطه‌ی گزارش
async function serverWindow(rec, chat, win) {
  const base = { chat: chat._id, deletedForEveryone: false, type: 'text' };
  const map = (m, anchorId) => {
    const e2e = !!(m.e2e?.senderDeviceId || m.groupE2e?.ciphertext);
    return { id: m._id, sender: m.sender?.displayName, senderId: m.sender?._id, at: m.createdAt, e2e, anchor: anchorId ? String(m._id) === String(anchorId) : false, text: e2e ? null : (chat.type === 'secret' ? m.content : decryptText(m.content)) };
  };
  if (win.full) {
    const msgs = await Message.find(base).sort({ createdAt: -1 }).limit(200).populate('sender', 'displayName');
    return msgs.reverse().map((m) => map(m, rec.targetMessage?._id));
  }
  if (!win.before && !win.after) return [];
  const anchorTime = rec.targetMessage?.createdAt || rec.createdAt;
  const [before, after] = await Promise.all([
    win.before ? Message.find({ ...base, createdAt: { $lte: anchorTime } }).sort({ createdAt: -1 }).limit(win.before + 1).populate('sender', 'displayName') : [],
    win.after ? Message.find({ ...base, createdAt: { $gt: anchorTime } }).sort({ createdAt: 1 }).limit(win.after).populate('sender', 'displayName') : [],
  ]);
  return [...before.reverse(), ...after].map((m) => map(m, rec.targetMessage?._id));
}

router.get('/cases/:kind/:id', async (req, res) => {
  const { kind, id } = req.params;
  const Model = modelOf(kind);
  if (!Model || !mongoose.isValidObjectId(id)) return res.status(404).json({ error: 'پرونده پیدا نشد' });
  let q = Model.findById(id).populate(kind === 'ai' ? 'accusedUser' : 'targetUser', 'displayName username moderation restrictions role staff.level').populate('assignedTo', 'displayName username').populate('escalations.by', 'displayName');
  if (kind === 'user') q = q.populate('reporter', 'displayName username moderation').populate('targetMessage');
  const rec = await q;
  if (!rec || !SP.mayViewCase(req.user, rec, req.staff.tiers)) return res.status(404).json({ error: 'پرونده پیدا نشد' }); // نداشتنِ دسترسی = ۴۰۴ تا وجودِ پرونده فاش نشود
  const win = req.staff.window;
  const chatId = kind === 'ai' ? rec.chat : rec.chat || rec.targetMessage?.chat;
  let serverMessages = []; let members = [];
  if (chatId) {
    const chat = await Chat.findById(chatId).populate('members.user', 'displayName username');
    if (chat) {
      if (win.full) members = chat.members.map((m) => ({ id: m.user?._id, name: m.user?.displayName }));
      serverMessages = await serverWindow(rec, chat, win);
    }
  }
  const accused = accusedOf(kind, rec);
  const plain = rec.toObject();
  const myLevel = req.staff.level;
  const sealedBox = kind === 'ai' ? sealedFor(plain.sealedBox, myLevel) : sealedFor(plain.sealedContext, myLevel);
  delete plain.sealedBox; delete plain.sealedContext;
  if (kind === 'ai' && !win.full) delete plain.reporter; // گزارش‌دهنده‌ی AI فقط برای ردیف‌های با دیدِ کامل
  const stats = accused && req.staff.can('users.view_stats') ? await userCaseStats(idOf(accused)) : null;
  const ladder = accused && req.staff.can('cases.confirm') && OPEN.includes(rec.status) ? await ladderPreview(accused, rec.category, await getPolicy()) : null;
  res.json({
    kind, case: plain, members, serverMessages, window: { full: win.full, before: win.before, after: win.after },
    sealedBox, myLevel, stats, ladder,
    activeRestrictions: accused ? activeRestrictions(accused) : [],
    can: { confirm: req.staff.can('cases.confirm'), decide: req.staff.can('cases.decide'), escalate: req.staff.can('cases.escalate') && myLevel > 0, reassign: req.staff.can('cases.reassign'), claim: req.staff.can('cases.claim') && !rec.assignedTo },
  });
});

// ---------- تصمیم ----------
// پلکان: منطقِ خالصِ utils/ladder.js (همان که پیش‌نمایشِ ادمین هم استفاده می‌کند)
async function ladderCounts(accusedId, policy, extra = {}) {
  const counts = {};
  for (const c of new Set(policy.escalation.map((st) => st.category || ''))) counts[c] = (await confirmedCount(accusedId, c || undefined)) + (extra[c] || 0);
  return counts;
}
async function applyLadder(app, accusedId, policy, { reason, already }) {
  const counts = await ladderCounts(accusedId, policy);
  const apps = freshApplications(planLadder(policy.escalation, (c) => counts[c] ?? 0), already);
  const applied = [];
  for (const a of apps) {
    const r = await addRestriction(accusedId, { features: a.features, days: a.days, reason: reason || 'تکرار تخلف', source: 'auto' });
    if (r) { a.features.forEach((f) => already.add(f)); applied.push({ features: r.features, until: r.until, auto: true, category: a.category }); }
  }
  return applied;
}
// پیش‌نمایش برای ادمین: «اگر همین پرونده تأیید شود» پلکان چه می‌کند + «یک پله بالاتر» (ادمین می‌تواند بیشتر از پله هم بدهد)
async function ladderPreview(accused, category, policy) {
  const counts = await ladderCounts(accused._id, policy, { '': 1, [category || '']: 1 });
  const plan = planLadder(policy.escalation, (c) => counts[c] ?? 0);
  const already = new Set(activeRestrictions(accused).flatMap((r) => r.features));
  return { willApply: freshApplications(plan, already), higher: higherStep(plan, category), counts };
}

function checkRestrictCap(req, days) {
  if (days === 0) return req.staff.can('users.restrict_permanent') ? null : 'محدودیتِ بدونِ تاریخ پایان برای ردیفِ شما مجاز نیست';
  const cap = req.staff.tier?.maxRestrictDays || 0;
  return cap > 0 && days > cap ? `سقفِ مدتِ محدودیت برای ردیفِ شما ${cap} روز است` : null;
}
async function assertStaffTarget(req, res, userId) {
  const target = await User.findById(userId).select('role staff');
  if (!target) { res.status(404).json({ error: 'کاربر پیدا نشد' }); return null; }
  if (SP.levelOf(target) !== null && !SP.canActOnStaff(req.user, target, req.staff.tiers)) { res.status(403).json({ error: 'اجازه‌ی این اقدام روی این حساب را ندارید' }); return null; }
  return target;
}

router.post('/cases/:kind/:id/decide', async (req, res) => {
  const { kind, id } = req.params;
  const { decision, accusedUserId, features: rawFeatures = [], days: rawDays = 0, reason: rawReason = '', notifyUser: doNotify = true, note: rawNote = '' } = req.body;
  if (!['confirm', 'under_review', 'dismiss'].includes(decision)) return res.status(400).json({ error: 'تصمیم نامعتبر' });
  const Model = modelOf(kind);
  if (!Model || !mongoose.isValidObjectId(id)) return res.status(404).json({ error: 'پرونده پیدا نشد' });
  const need = decision === 'confirm' ? 'cases.confirm' : 'cases.decide';
  if (!req.staff.can(need)) return res.status(403).json({ error: 'این تصمیم برای ردیفِ شما مجاز نیست؛ می‌توانید پرونده را ارجاع دهید', code: 'PERMISSION_DENIED', permission: need });
  const features = (Array.isArray(rawFeatures) ? rawFeatures : []).filter((f) => FEATURES[f]);
  const days = clampNumber(rawDays, 0, 3650, 0);
  const reason = String(rawReason || '').slice(0, 300);
  const note = String(rawNote || '').slice(0, 1000);
  const rec = await Model.findById(id);
  if (!rec || !SP.mayViewCase(req.user, rec, req.staff.tiers)) return res.status(404).json({ error: 'پرونده پیدا نشد' });
  if (['confirmed', 'dismissed'].includes(rec.status)) return res.status(409).json({ error: 'این پرونده قبلاً نهایی شده است' });
  if (decision === 'confirm' && features.length) {
    if (!req.staff.can('users.restrict')) return res.status(403).json({ error: 'اعمالِ محدودیت برای ردیفِ شما مجاز نیست', code: 'PERMISSION_DENIED', permission: 'users.restrict' });
    const capErr = checkRestrictCap(req, days);
    if (capErr) return res.status(403).json({ error: capErr, code: 'RESTRICT_CAP' });
  }
  // متهمِ ثبت‌شده در پرونده تغییر نمی‌کند؛ فقط وقتی ثبت نشده (گزارش گروه/کانال) و باید عضوِ همان چت باشد
  const recAccused = accusedOf(kind, rec);
  let accusedId = recAccused;
  if (!recAccused && accusedUserId) {
    if (!mongoose.isValidObjectId(accusedUserId) || !rec.chat || !(await Chat.exists({ _id: rec.chat, 'members.user': accusedUserId }))) return res.status(400).json({ error: 'متهم باید عضو همان گروه/کانال باشد' });
    accusedId = accusedUserId;
  }
  if (accusedId && !(await assertStaffTarget(req, res, accusedId))) return;

  // نهایی‌شدنِ اتمیک: دو ناظرِ هم‌زمان / دابل‌تپ فقط یک‌بار اثر می‌گذارد
  const status = decision === 'confirm' ? 'confirmed' : decision === 'dismiss' ? 'dismissed' : 'under_review';
  const set = { status, decision: { by: req.user.id, at: new Date(), decision, features, days, reason, note, applied: [] }, reviewedBy: req.user.id, dueAt: status === 'under_review' ? rec.dueAt : null };
  set[kind === 'ai' ? 'reviewed' : 'resolved'] = status !== 'under_review';
  if (accusedId && !recAccused) set[kind === 'ai' ? 'accusedUser' : 'targetUser'] = accusedId;
  const claimed = await Model.findOneAndUpdate({ _id: id, status: { $in: OPEN } }, { $set: set }, { new: true });
  if (!claimed) return res.status(409).json({ error: 'این پرونده قبلاً نهایی شده است' });

  const policy = await getPolicy();
  const applied = [];
  if (decision === 'confirm') {
    if (!accusedId) { await Model.updateOne({ _id: id }, { $set: { status: rec.status } }); return res.status(400).json({ error: 'متهم مشخص نیست' }); }
    const accused = await User.findByIdAndUpdate(accusedId, { $inc: { 'moderation.reportsAgainstConfirmed': 1 }, $set: { 'moderation.underReview': false } }, { new: true });
    const already = new Set(activeRestrictions(accused).flatMap((r) => r.features));
    if (features.length) { const r = await addRestriction(accusedId, { features, days, reason, source: 'admin' }); if (r) { applied.push({ features: r.features, until: r.until }); r.features.forEach((f) => already.add(f)); } }
    applied.push(...(await applyLadder(req.app, accusedId, policy, { reason, already })));
    if (doNotify && applied.length) {
      const lines = applied.map((a) => `• ${a.features.map((f) => FEATURES[f]).join('، ')} — ${a.until ? 'تا ' + new Date(a.until).toLocaleDateString('fa-IR') : 'تا اطلاع ثانوی'}`).join('\n');
      await notifyUser(req.app, accusedId, `به‌خاطر گزارش بررسی‌شده${reason ? ` («${reason}»)` : ''}، این محدودیت‌ها روی حساب شما اعمال شد:\n${lines}`);
    }
  } else if (decision === 'under_review') {
    if (accusedId) await User.findByIdAndUpdate(accusedId, { $set: { 'moderation.underReview': true, 'moderation.reviewNote': note || reason } });
    if (doNotify && accusedId) await notifyUser(req.app, accusedId, 'گزارشی درباره‌ی حساب شما بررسی شد؛ فعلاً محدودیتی اعمال نمی‌شود، ولی رفتار حساب مدتی تحت نظر است.');
  }
  // آمارِ گزارش‌دهنده و جریمه‌ی گزارش‌دهنده‌ی الکی (فقط گزارش‌های دستیِ کاربر؛ خطای مدلِ هوش مصنوعی «گزارشِ جعلی» حساب نمی‌شود)
  if (kind === 'user' && claimed.reporter && decision !== 'under_review') {
    const field = decision === 'confirm' ? 'moderation.reportsFiledConfirmed' : 'moderation.reportsFiledRejected';
    const reporter = await User.findByIdAndUpdate(claimed.reporter, { $inc: { [field]: 1 } }, { new: true });
    const fr = policy.falseReporter; const m = reporter.moderation;
    const total = m.reportsFiledConfirmed + m.reportsFiledRejected;
    if (decision === 'dismiss' && m.reportsFiledRejected >= fr.rejectedThreshold && m.reportsFiledRejected / Math.max(total, 1) >= fr.minRejectRatio) {
      const r = await addRestriction(reporter._id, { features: fr.features, days: fr.days, reason: 'ثبت مکرر گزارش‌های نادرست', source: 'auto' });
      if (r) await notifyUser(req.app, reporter._id, 'چون چند گزارش اخیرتان بررسی و نادرست تشخیص داده شد، ثبت گزارش برای مدتی غیرفعال شد.');
    }
  }
  await Model.updateOne({ _id: id }, { $set: { 'decision.applied': applied } });
  await log(req.user.id, 'moderation_decision', `${kind}:${id} ${decision}`);
  res.json({ ok: true, applied });
});

// ---------- ارجاع / برداشتن / واگذاری ----------
async function loadCase(req, res) {
  const Model = modelOf(req.params.kind);
  if (!Model || !mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: 'پرونده پیدا نشد' }); return null; }
  const rec = await Model.findById(req.params.id);
  if (!rec || !SP.mayViewCase(req.user, rec, req.staff.tiers)) { res.status(404).json({ error: 'پرونده پیدا نشد' }); return null; }
  if (!OPEN.includes(rec.status)) { res.status(409).json({ error: 'این پرونده قبلاً نهایی شده است' }); return null; }
  return rec;
}
router.post('/cases/:kind/:id/escalate', requirePerm('cases.escalate'), async (req, res) => {
  const rec = await loadCase(req, res); if (!rec) return;
  const r = await escalate(rec, { by: req.user._id, reason: req.body?.reason });
  if (!r.ok) return res.status(400).json({ error: r.error });
  await log(req.user.id, 'case_escalate', `${req.params.kind}:${rec._id} ${r.from}->${r.to}`);
  res.json({ ok: true, tier: r.to });
});
router.post('/cases/:kind/:id/claim', requirePerm('cases.claim'), async (req, res) => {
  const rec = await loadCase(req, res); if (!rec) return;
  const claimed = await rec.constructor.findOneAndUpdate({ _id: rec._id, assignedTo: null, status: { $in: OPEN }, tier: { $gte: req.staff.level } }, { $set: { assignedTo: req.user._id, assignedAt: new Date() } }, { new: true });
  if (!claimed) return res.status(409).json({ error: 'این پرونده مسئول دارد یا مالِ ردیفِ بالاتری است' });
  res.json({ ok: true });
});
router.post('/cases/:kind/:id/assign', requirePerm('cases.reassign'), async (req, res) => {
  const rec = await loadCase(req, res); if (!rec) return;
  const targetId = req.body?.userId;
  if (!mongoose.isValidObjectId(targetId)) return res.status(400).json({ error: 'ناظر نامعتبر است' });
  const target = await User.findById(targetId).select('role staff status');
  const lvl = SP.levelOf(target);
  if (!target || lvl === null || ['banned', 'deleted'].includes(target.status)) return res.status(400).json({ error: 'این کاربر ناظر نیست' });
  if (lvl < req.staff.level) return res.status(403).json({ error: 'واگذاری فقط به هم‌ردیف یا پایین‌تر ممکن است؛ برای بالاتر «ارجاع» بزنید' });
  rec.assignedTo = target._id; rec.assignedAt = new Date();
  await rec.save();
  await log(req.user.id, 'case_assign', `${req.params.kind}:${rec._id} -> ${target._id}`);
  res.json({ ok: true });
});

// ---------- تابلو، ردیف‌ها، مسیریابی ----------
router.get('/staff/board', requirePerm('staff.view_board'), async (req, res) => res.json({ board: await board(), myLevel: req.staff.level }));

router.get('/staff/tiers', (req, res) => {
  const mine = SP.permissionsOf(req.user, req.staff.tiers);
  res.json({ tiers: req.staff.tiers, routing: req.staff.routing, permissions: SP.PERMISSIONS, myLevel: req.staff.level, myPermissions: mine.has('*') ? SP.ALL_PERMISSIONS : [...mine], tierKeys: Object.fromEntries(Object.entries(req.staff.settings.moderationTierKeys || {}).map(([k, v]) => [k, { version: v?.version || 1, hasKey: !!v?.publicKey }])) });
});
const tierSig = (t) => JSON.stringify({ n: t.name, s: t.caseScope, c: t.context, m: t.maxRestrictDays, p: [...t.permissions].sort() });
router.put('/staff/tiers', requirePerm('staff.manage'), async (req, res) => {
  const r = SP.sanitizeTiers(req.body?.tiers);
  if (r.error) return res.status(400).json({ error: r.error });
  const me = req.staff.level;
  const old = new Map(req.staff.tiers.map((t) => [t.level, t]));
  const next = new Map(r.tiers.map((t) => [t.level, t]));
  const myPerms = SP.permissionsOf(req.user, req.staff.tiers);
  for (const [lvl, t] of old) if (lvl <= me && me > 0) { // ردیف‌های هم‌سطح/بالاتر از خودم را نمی‌شود تغییر داد یا حذف کرد
    const n = next.get(lvl);
    if (!n || tierSig(n) !== tierSig(t)) return res.status(403).json({ error: 'تغییرِ ردیف‌های هم‌سطح یا بالاتر از خودتان مجاز نیست' });
  }
  for (const t of r.tiers) if (t.level > me) { // هیچ‌کس بیش از دسترسیِ خودش نمی‌دهد
    const extra = t.permissions.find((p) => p !== '*' && !myPerms.has('*') && !myPerms.has(p));
    if (extra) return res.status(403).json({ error: `نمی‌توانید دسترسیِ «${extra}» را بدهید؛ خودتان ندارید` });
  }
  const inUse = new Set((await activeStaff()).map((s) => s.level));
  for (const lvl of old.keys()) if (!next.has(lvl) && inUse.has(lvl)) return res.status(409).json({ error: `ردیفِ ${lvl} هنوز ادمین دارد؛ اول آن‌ها را جابه‌جا کنید` });
  await updateSettings({ staffTiers: r.tiers });
  await log(req.user.id, 'update_tiers', `${r.tiers.length} tiers`);
  res.json({ tiers: r.tiers });
});
router.put('/routing', requirePerm('routing.edit'), async (req, res) => {
  const routing = SP.resolveRouting(req.body);
  const lv = new Set(req.staff.tiers.map((t) => t.level));
  if (![routing.initialTier, ...Object.values(routing.byCategory)].every((l) => lv.has(l))) return res.status(400).json({ error: 'ردیفِ انتخاب‌شده وجود ندارد' });
  await updateSettings({ moderationRouting: routing });
  await log(req.user.id, 'update_routing', JSON.stringify(routing));
  res.json({ routing });
});

// ---------- مدیریتِ ادمین‌ها ----------
const staffView = (u) => ({ id: u._id, username: u.username, displayName: u.displayName, role: u.role, level: SP.levelOf(u), grant: u.staff?.grant || [], revoke: u.staff?.revoke || [], isOnline: !!u.isOnline, hasKey: !!u.staff?.publicKey, addedAt: u.staff?.addedAt || null });
router.get('/staff', requirePerm('staff.view_board'), async (req, res) => {
  const users = await User.find({ role: { $in: ['admin', 'moderator'] }, status: { $nin: ['deleted'] } }).select('username displayName role staff isOnline');
  res.json(users.map(staffView).filter((u) => u.level !== null).sort((a, b) => a.level - b.level));
});
router.get('/staff/lookup', requirePerm('staff.manage'), async (req, res) => {
  const username = String(req.query.username || '').trim().toLowerCase().replace(/^@/, '').slice(0, 40);
  if (!username) return res.status(400).json({ error: 'نام کاربری لازم است' });
  const u = await User.findOne({ username }).select('username displayName role staff isOnline status');
  if (!u || u.status === 'deleted') return res.status(404).json({ error: 'کاربر پیدا نشد' });
  res.json(staffView(u));
});
router.put('/staff/:id', requirePerm('staff.manage'), async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  if (String(id) === String(req.user._id)) return res.status(403).json({ error: 'روی حسابِ خودتان نمی‌توانید این کار را بکنید' });
  const target = await User.findById(id).select('role staff status');
  if (!target || target.status === 'deleted') return res.status(404).json({ error: 'کاربر پیدا نشد' });
  const targetLevel = SP.levelOf(target);
  if (targetLevel !== null && !SP.canActOnStaff(req.user, target, req.staff.tiers)) return res.status(403).json({ error: 'اجازه‌ی این اقدام روی این حساب را ندارید' });
  const { level, grant, revoke } = req.body || {};
  const set = {};
  if (level === null) {
    set.role = 'user'; set['staff.level'] = null; set['staff.grant'] = []; set['staff.revoke'] = []; set['staff.wrappedKeys'] = []; set['staff.publicKey'] = '';
  } else if (level !== undefined) {
    if (!Number.isInteger(level) || level < 1 || level > SP.MAX_LEVEL) return res.status(400).json({ error: 'ردیف نامعتبر است' });
    if (level <= req.staff.level) return res.status(403).json({ error: 'ردیفِ جدید باید پایین‌تر از ردیفِ خودتان باشد' });
    if (!req.staff.tiers.some((t) => t.level === level)) return res.status(400).json({ error: 'این ردیف تعریف نشده است' });
    set.role = 'moderator'; set['staff.level'] = level;
    if (targetLevel === null) { set['staff.addedBy'] = req.user._id; set['staff.addedAt'] = new Date(); }
    if (targetLevel !== null && targetLevel !== level) set['staff.wrappedKeys'] = []; // کلیدِ ردیفِ قبلی دیگر معتبر نیست
  } else if (targetLevel === null) return res.status(400).json({ error: 'ردیف مشخص نشده' });
  const myPerms = SP.permissionsOf(req.user, req.staff.tiers);
  if (grant !== undefined) {
    if (!Array.isArray(grant)) return res.status(400).json({ error: 'grant نامعتبر است' });
    const g = [...new Set(grant)].filter((p) => SP.ALL_PERMISSIONS.includes(p));
    if (g.some((p) => !myPerms.has('*') && !myPerms.has(p))) return res.status(403).json({ error: 'نمی‌توانید دسترسی‌ای را بدهید که خودتان ندارید' });
    set['staff.grant'] = g;
  }
  if (revoke !== undefined) {
    if (!Array.isArray(revoke)) return res.status(400).json({ error: 'revoke نامعتبر است' });
    set['staff.revoke'] = [...new Set(revoke)].filter((p) => SP.ALL_PERMISSIONS.includes(p));
  }
  await User.updateOne({ _id: id }, { $set: set });
  if (level === null || (level !== undefined && targetLevel !== null && targetLevel !== level)) {
    // پرونده‌های بازِ او بدونِ مسئول می‌شوند تا دوباره برداشته/ارجاع شوند
    await Promise.all([Report, EncryptedReport].map((M) => M.updateMany({ assignedTo: id, status: { $in: OPEN } }, { $set: { assignedTo: null, assignedAt: null } })));
  }
  await log(req.user.id, 'staff_update', `${id} ${JSON.stringify({ level, grant, revoke })}`);
  const fresh = await User.findById(id).select('username displayName role staff isOnline');
  res.json(staffView(fresh));
});

// ---------- کلیدها (مهروموم چندردیفی) ----------
router.put('/tier-keys', requirePerm('keys.manage'), async (req, res) => {
  const incoming = req.body?.keys;
  if (!isPlain(incoming)) return res.status(400).json({ error: 'keys نامعتبر است' });
  const merged = { ...(req.staff.settings.moderationTierKeys || {}) };
  for (const [k, v] of Object.entries(incoming)) {
    const lvl = Number(k);
    if (!Number.isInteger(lvl) || lvl < 1 || lvl > SP.MAX_LEVEL || !req.staff.tiers.some((t) => t.level === lvl)) return res.status(400).json({ error: `ردیفِ ${k} نامعتبر است` });
    if (typeof v?.publicKey !== 'string' || v.publicKey.length > 200 || !B64URL.test(v.publicKey)) return res.status(400).json({ error: 'کلیدِ عمومی نامعتبر است' });
    const prev = merged[k];
    merged[k] = { publicKey: v.publicKey, version: prev?.publicKey === v.publicKey ? prev.version : (prev?.version || 0) + 1 };
  }
  await updateSettings({ moderationTierKeys: merged });
  await log(req.user.id, 'update_tier_keys', Object.keys(incoming).join(','));
  res.json({ keys: Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, { version: v.version, publicKey: v.publicKey }])) });
});
router.put('/staff/me/key', async (req, res) => {
  const pk = req.body?.publicKey;
  if (typeof pk !== 'string' || pk.length > 200 || !B64URL.test(pk)) return res.status(400).json({ error: 'کلیدِ عمومی نامعتبر است' });
  await User.updateOne({ _id: req.user._id }, { $set: { 'staff.publicKey': pk } });
  res.json({ ok: true });
});
router.get('/staff/me/keys', async (req, res) => {
  const me = await User.findById(req.user._id).select('staff');
  res.json({ level: req.staff.level, publicKey: me.staff?.publicKey || '', wrappedKeys: (me.staff?.wrappedKeys || []).map((w) => ({ level: w.level, version: w.version, sealed: w.sealed })) });
});
router.put('/staff/:id/wrapped-keys', requirePerm('keys.manage'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  const target = await User.findById(req.params.id).select('role staff');
  const tl = SP.levelOf(target);
  if (!target || tl === null) return res.status(404).json({ error: 'ناظر پیدا نشد' });
  const list = req.body?.keys;
  if (!Array.isArray(list) || !list.length || list.length > 10) return res.status(400).json({ error: 'keys نامعتبر است' });
  const byLevel = new Map((target.staff?.wrappedKeys || []).map((w) => [w.level, { level: w.level, version: w.version, sealed: w.sealed }]));
  for (const k of list) {
    if (!Number.isInteger(k?.level) || k.level < tl || k.level > SP.MAX_LEVEL) return res.status(400).json({ error: 'ردیفِ کلید برای این ناظر مجاز نیست' });
    if (!isPlain(k.sealed) || JSON.stringify(k.sealed).length > 4096) return res.status(400).json({ error: 'کلیدِ مهروموم نامعتبر است' });
    byLevel.set(k.level, { level: k.level, version: Number.isInteger(k.version) && k.version > 0 ? k.version : 1, sealed: k.sealed });
  }
  await User.updateOne({ _id: target._id }, { $set: { 'staff.wrappedKeys': [...byLevel.values()] } });
  await log(req.user.id, 'staff_wrapped_keys', `${target._id}`);
  res.json({ ok: true });
});
router.get('/staff/:id/public-key', async (req, res) => {
  if (!req.staff.can('keys.manage') && !req.staff.can('staff.manage')) return res.status(403).json({ error: 'دسترسی ندارید', code: 'PERMISSION_DENIED' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  const u = await User.findById(req.params.id).select('role staff');
  if (!u || SP.levelOf(u) === null) return res.status(404).json({ error: 'ناظر پیدا نشد' });
  res.json({ publicKey: u.staff?.publicKey || '', level: SP.levelOf(u) });
});

// ---------- پرونده‌ی هر کاربر و محدودیت‌ها ----------
router.get('/users/:id/moderation', requirePerm('users.view_stats'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  const user = await User.findById(req.params.id).select('displayName username moderation restrictions status');
  if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  const stats = await userCaseStats(user._id);
  const m = user.moderation;
  res.json({
    user, stats,
    totals: { reportsAgainst: stats.ai.total + stats.user.total, reportsAgainstConfirmed: m.reportsAgainstConfirmed, filed: m.reportsFiledConfirmed + m.reportsFiledRejected, filedRejected: m.reportsFiledRejected },
    active: activeRestrictions(user), all: user.restrictions, features: FEATURES,
  });
});
router.post('/users/:id/restrictions', requirePerm('users.restrict'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id) || !(await assertStaffTarget(req, res, req.params.id))) return;
  const { features, notifyUser: doNotify } = req.body;
  const days = clampNumber(req.body?.days, 0, 3650, 0);
  const capErr = checkRestrictCap(req, days);
  if (capErr) return res.status(403).json({ error: capErr, code: 'RESTRICT_CAP' });
  const reason = String(req.body?.reason || '').slice(0, 300);
  const r = await addRestriction(req.params.id, { features, days, reason });
  if (!r) return res.status(400).json({ error: 'حداقل یک قابلیت انتخاب کن' });
  if (doNotify) await notifyUser(req.app, req.params.id, `این محدودیت‌ها روی حساب شما اعمال شد: ${r.features.map((f) => FEATURES[f]).join('، ')}${reason ? `\nدلیل: ${reason}` : ''}`);
  await log(req.user.id, 'restrict_user', `${req.params.id} ${r.features.join(',')}`);
  res.json({ ok: true });
});
router.delete('/users/:id/restrictions/:rid', requirePerm('users.restrict'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id) || !(await assertStaffTarget(req, res, req.params.id))) return;
  await User.updateOne({ _id: req.params.id }, { $pull: { restrictions: { _id: req.params.rid } } });
  await log(req.user.id, 'lift_restriction', `${req.params.id} ${req.params.rid}`);
  res.json({ ok: true });
});
router.get('/watchlist', requirePerm('users.view_stats'), async (req, res) => res.json(await User.find({ 'moderation.underReview': true }).select('displayName username moderation')));
router.post('/users/:id/clear-watch', requirePerm('users.restrict'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  await User.updateOne({ _id: req.params.id }, { $set: { 'moderation.underReview': false } });
  res.json({ ok: true });
});

// ---------- یادگیری از تصمیم‌ها ----------
// ادمین بعد از تصمیم، «همان یک پیامِ بررسی‌شده» را از گوشیِ خودش می‌فرستد (سرور محتوای E2E را نمی‌بیند). برچسب را سرور از نتیجه‌ی پرونده
// می‌سازد (تأیید ⇒ دسته، رد ⇒ normal) و فقط کسی که خودش تصمیم گرفته می‌تواند نمونه بدهد؛ پس نمونه‌ی جعلی/برچسبِ دلخواه ممکن نیست.
router.post('/samples', requirePerm('cases.decide'), async (req, res) => {
  const { id } = req.body || {};
  const policy = await getPolicy();
  if (!policy.training.enabled) return res.json({ ok: true, skipped: 'disabled' });
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: 'پرونده نامعتبر است' });
  const rec = await EncryptedReport.findById(id);
  if (!rec || !['confirmed', 'dismissed'].includes(rec.status)) return res.status(409).json({ error: 'پرونده هنوز نهایی نشده' });
  if (String(rec.decision?.by) !== String(req.user._id)) return res.status(403).json({ error: 'فقط تصمیم‌گیرنده‌ی همین پرونده می‌تواند نمونه بدهد' });
  const text = String(req.body.text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 600);
  if (!text) return res.status(400).json({ error: 'متن خالی است' });
  const conf = Number(req.body.confidence);
  const lang = /^[a-z]{2,3}$/.test(req.body.lang || '') ? req.body.lang : 'fa';
  await TrainingSample.updateOne({ caseId: rec._id }, { $set: { text, label: rec.status === 'confirmed' ? rec.category : 'normal', reportedCategory: rec.category, confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : null, lang } }, { upsert: true });
  res.json({ ok: true });
});
router.get('/calibration', requirePerm('policy.edit'), async (req, res) => {
  const out = await runCalibration({ apply: false });
  res.json({ ...out, training: (await getPolicy()).training });
});
router.post('/calibration/run', requirePerm('policy.edit'), async (req, res) => {
  const out = await runCalibration({ apply: true });
  await log(req.user.id, 'calibration_run', JSON.stringify(out.changes));
  res.json(out);
});
// برای آموزشِ دوباره (model-training/retrain_from_server.py): فقط کسی که مدل‌ها را مدیریت می‌کند
router.get('/samples/export', requirePerm('models.manage'), async (req, res) => {
  const filter = /^[a-z]{2,3}$/.test(req.query.lang || '') ? { lang: req.query.lang } : {};
  const rows = await TrainingSample.find(filter).sort({ createdAt: -1 }).limit(50000).select('text label reportedCategory confidence lang -_id').lean();
  res.json({ count: rows.length, samples: rows });
});

module.exports = router;
