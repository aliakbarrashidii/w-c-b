// تست یکپارچه‌ی سطح‌بندیِ ادمین‌ها: مسیریابی، ارجاع، پنجره‌ی بافت، دسترسی‌ها، سقفِ محدودیت، آمار، کلیدها، مهروموم.
// اجرا:  TEST_MONGO_URI=mongodb://127.0.0.1:27017 node --test --test-force-exit tests/staff.integration.test.js
process.env.JWT_SECRET = 'test-secret';
process.env.MESSAGE_ENCRYPTION_KEY = 'b'.repeat(64);
require('../src/utils/asyncErrors');

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const SKIP = process.env.TEST_MONGO_URI ? false : 'TEST_MONGO_URI تنظیم نشده';
const User = require('../src/models/User');
const Chat = require('../src/models/Chat');
const Message = require('../src/models/Message');
const Report = require('../src/models/Report');
const EncryptedReport = require('../src/models/EncryptedReport');
const ModerationModel = require('../src/models/ModerationModel');
const TrainingSample = require('../src/models/TrainingSample');
const Settings = require('../src/models/Settings');
const { updateSettings, getSettings } = require('../src/utils/settings');
const { encryptText } = require('../src/utils/crypto');
const { sweepEscalations } = require('../src/utils/caseRouting');

// آیا این دیتابیس به‌روزرسانیِ شرطیِ تک‌سندیِ هم‌زمان را اتمیک انجام می‌دهد؟ MongoDB واقعی بله؛ FerretDB 1.x (sqlite) نه
// (در آزمایش، از ۴ درخواستِ هم‌زمان گاهی ۲ تا ۴ تا «برنده» می‌شدند). تستِ هم‌زمانی فقط روی دیتابیسِ اتمیک معنا دارد.
let dbAtomic = true;
async function probeAtomicity(rounds = 40, n = 4) {
  const col = mongoose.connection.db.collection('atomprobe');
  for (let r = 0; r < rounds; r += 1) {
    const { insertedId } = await col.insertOne({ status: 'pending' });
    const res = await Promise.all(Array.from({ length: n }, () => col.updateOne({ _id: insertedId, status: 'pending' }, { $set: { status: 'done' } })));
    if (res.filter((x) => x.modifiedCount === 1).length > 1) return false;
  }
  return true;
}
let srv; let base; let owner; let deputy; let senior; let mod3; let mod3b; let alice; let bob; let carol; let chat;
const tok = (u) => jwt.sign({ id: String(u._id), role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
const api = async (u, method, path, body) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok(u)}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const B = (n) => Buffer.from(String(n).padEnd(32, 'x')).toString('base64');
const box1 = () => ({ ephemeralPublicKey: B('e'), nonce: B('n'), ciphertext: B('c') });
const box2 = (levels) => ({ v: 2, nonce: B('payloadnonce'), ciphertext: B('payloadct'), keys: levels.map((l) => ({ level: l, version: 1, ephemeralPublicKey: B('e' + l), nonce: B('n' + l), ciphertext: B('c' + l) })) });
const reset = async () => {
  await Promise.all([Report, EncryptedReport, TrainingSample].map((M) => M.deleteMany({})));
  // کاربرهای عادی: هر تستی که آن‌ها را ناظر کرده باید پاک شود تا تست بعدی از «ناظرِ هم‌ردیف» اثر نگیرد
  await User.updateMany({ _id: { $in: [alice._id, bob._id, carol._id] } }, { $set: { restrictions: [], moderation: {}, role: 'user', 'staff.level': null, 'staff.grant': [], 'staff.revoke': [], 'staff.wrappedKeys': [], status: 'active' } });
  await updateSettings({ moderationRouting: { initialTier: 3 }, moderationPolicy: {}, staffTiers: null, moderationTierKeys: {} });
  await User.updateMany({ _id: { $in: [owner._id, deputy._id, senior._id, mod3._id, mod3b._id] } }, { $set: { status: 'active', isOnline: false } });
};
let seq = 0;
const userReport = (reporter, accused, category = 'harassment') => Report.create({ reporter: reporter._id, targetType: 'user', targetUser: accused._id, category, chat: chat._id });
const aiReport = (reporter, accused, category = 'sexual_harassment', sealedBox = box2([0, 2, 3])) => EncryptedReport.create({ chat: chat._id, reporter: reporter._id, accusedUser: accused._id, category, sealedBox });

test.before(async () => {
  if (SKIP) return;
  await mongoose.connect(process.env.TEST_MONGO_URI, { dbName: `wizstaff_${Date.now()}` });
  await Promise.all([User, Chat, Message, Report, EncryptedReport, ModerationModel, Settings].map((M) => M.init().catch(() => {})));
  dbAtomic = await probeAtomicity();
  const mk = (username, extra = {}) => User.create({ username, displayName: username, passwordHash: 'x', ...extra });
  owner = await mk('owner', { role: 'admin' });
  deputy = await mk('deputy', { role: 'moderator', staff: { level: 1 } });
  senior = await mk('senior', { role: 'moderator', staff: { level: 2 } });
  mod3 = await mk('mod3', { role: 'moderator' }); // قدیمی: بدونِ staff.level ⇒ ردیفِ ۳
  mod3b = await mk('mod3b', { role: 'moderator', staff: { level: 3 } });
  alice = await mk('alice'); bob = await mk('bob'); carol = await mk('carol');
  chat = await Chat.create({ type: 'group', title: 'g', members: [alice, bob, carol].map((u) => ({ user: u._id })) });
  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('../src/routes/admin'));
  app.use('/api/moderation', require('../src/routes/moderation'));
  app.use('/api/reports', require('../src/routes/reports'));
  app.use((err, req, res, next) => res.status(500).json({ error: String(err.message) })); // eslint-disable-line no-unused-vars
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(async () => {
  if (SKIP) return;
  srv?.close();
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
});
test.beforeEach(async () => { if (!SKIP) await reset(); });

test('پیش‌فرض: ادمینِ قدیمی = ردیفِ ۰ با همه‌ی دسترسی‌ها؛ ناظرِ قدیمی = ردیفِ ۳', { skip: SKIP }, async () => {
  const o = await api(owner, 'GET', '/api/admin/moderation/staff/tiers');
  assert.equal(o.status, 200); assert.equal(o.json.myLevel, 0);
  assert.ok(o.json.myPermissions.includes('staff.manage') && o.json.myPermissions.includes('keys.manage'));
  const m = await api(mod3, 'GET', '/api/admin/moderation/staff/tiers');
  assert.equal(m.json.myLevel, 3);
  assert.ok(!m.json.myPermissions.includes('cases.confirm'));
  const nobody = await api(alice, 'GET', '/api/admin/moderation/staff/tiers');
  assert.equal(nobody.status, 403);
});

test('مسیریابی: ردیفِ اولیه + مسئولِ آنلاین و کم‌بار؛ بدونِ آنلاین ⇒ بی‌مسئول در صف', { skip: SKIP }, async () => {
  let r = await userReport(alice, bob); // مستقیم (بدون هوک) برای آماده‌سازی؛ مسیر واقعی را از API می‌زنیم
  await Report.deleteMany({});
  await User.updateOne({ _id: mod3b._id }, { $set: { isOnline: true } });
  let res = await api(alice, 'POST', '/api/reports', { targetType: 'user', targetUserId: String(bob._id), category: 'harassment' });
  assert.equal(res.status, 201);
  r = await Report.findById(res.json.id);
  assert.equal(r.tier, 3); assert.equal(String(r.assignedTo), String(mod3b._id)); // mod3b آنلاین است، mod3 نه
  // هیچ‌کس آنلاین نیست
  await User.updateMany({ _id: mod3b._id }, { $set: { isOnline: false } });
  res = await api(alice, 'POST', '/api/reports', { targetType: 'user', targetUserId: String(carol._id), category: 'harassment' });
  r = await Report.findById(res.json.id);
  assert.equal(r.tier, 3); assert.equal(r.assignedTo, null);
});

test('مسیریابیِ دسته‌به‌دسته و افتادن به ردیفِ بالاترِ دارای ادمین', { skip: SKIP }, async () => {
  await updateSettings({ moderationRouting: { initialTier: 3, byCategory: { violence: 2 } } });
  await User.updateMany({ _id: { $in: [senior._id] } }, { $set: { isOnline: true } });
  let res = await api(alice, 'POST', '/api/reports', { targetType: 'user', targetUserId: String(bob._id), category: 'violence' });
  let r = await Report.findById(res.json.id);
  assert.equal(r.tier, 2); assert.equal(String(r.assignedTo), String(senior._id));
  await User.updateOne({ _id: senior._id }, { $set: { status: 'banned' } }); // ردیفِ ۲ دیگر ادمینِ فعال ندارد ⇒ ردیفِ ۱
  res = await api(alice, 'POST', '/api/reports', { targetType: 'user', targetUserId: String(carol._id), category: 'violence' });
  r = await Report.findById(res.json.id);
  assert.equal(r.tier, 1);
});

test('ارجاع: ناظر به ردیفِ بالاتر می‌دهد، دیگر نمی‌بیندش؛ از ردیفِ ۰ ممکن نیست', { skip: SKIP }, async () => {
  await User.updateOne({ _id: mod3b._id }, { $set: { isOnline: true } });
  const res = await api(alice, 'POST', '/api/reports', { targetType: 'user', targetUserId: String(bob._id), category: 'harassment' });
  const id = res.json.id;
  assert.equal((await api(mod3b, 'GET', `/api/admin/moderation/cases/user/${id}`)).status, 200);
  const esc = await api(mod3b, 'POST', `/api/admin/moderation/cases/user/${id}/escalate`, { reason: 'نیاز به بررسیِ بیشتر' });
  assert.equal(esc.status, 200); assert.equal(esc.json.tier, 2);
  const r = await Report.findById(id);
  assert.equal(r.escalations.length, 1); assert.equal(r.escalations[0].from, 3); assert.equal(r.escalations[0].auto, false);
  assert.equal((await api(mod3b, 'GET', `/api/admin/moderation/cases/user/${id}`)).status, 404); // دیگر مالِ او نیست و واگذار هم نشده
  // مدیر اصلی (ردیفِ ۰) همه‌ی پرونده‌ها را می‌بیند و می‌تواند پرونده‌ی ردیفِ ۲ را هم یک پله بالاتر ببرد
  assert.equal((await api(owner, 'GET', `/api/admin/moderation/cases/user/${id}`)).status, 200);
  assert.equal((await api(owner, 'POST', `/api/admin/moderation/cases/user/${id}/escalate`, {})).json.tier, 1);
});

test('ارجاع از ردیفِ ۰ ممکن نیست', { skip: SKIP }, async () => {
  await updateSettings({ moderationRouting: { initialTier: 0 } });
  const res = await api(alice, 'POST', '/api/reports', { targetType: 'user', targetUserId: String(bob._id), category: 'harassment' });
  const r = await api(owner, 'POST', `/api/admin/moderation/cases/user/${res.json.id}/escalate`, {});
  assert.equal(r.status, 400); // پرونده در بالاترین ردیف است
  assert.match(r.json.error, /بالاترین/);
});

test('واگذاری: به هم‌ردیف/پایین‌تر مجاز، به بالاتر ممنوع', { skip: SKIP }, async () => {
  await updateSettings({ moderationRouting: { initialTier: 2 } });
  await User.updateOne({ _id: senior._id }, { $set: { isOnline: true } });
  const res = await api(alice, 'POST', '/api/reports', { targetType: 'user', targetUserId: String(bob._id), category: 'harassment' });
  const id = res.json.id;
  assert.equal((await api(senior, 'POST', `/api/admin/moderation/cases/user/${id}/assign`, { userId: String(deputy._id) })).status, 403);
  assert.equal((await api(senior, 'POST', `/api/admin/moderation/cases/user/${id}/assign`, { userId: String(mod3b._id) })).status, 200);
  assert.equal((await api(mod3b, 'GET', `/api/admin/moderation/cases/user/${id}`)).status, 200); // واگذارشده به خودش ⇒ می‌بیند
  assert.equal((await api(senior, 'POST', `/api/admin/moderation/cases/user/${id}/assign`, { userId: String(alice._id) })).status, 400); // کاربرِ عادی ناظر نیست
});

test('SLA: پرونده‌ی بدونِ رسیدگی بعد از مهلت خودکار ارجاع می‌شود', { skip: SKIP }, async () => {
  await updateSettings({ moderationRouting: { initialTier: 3, escalateAfterMin: { 3: 1 } } });
  const res = await api(alice, 'POST', '/api/reports', { targetType: 'user', targetUserId: String(bob._id), category: 'harassment' });
  let r = await Report.findById(res.json.id);
  assert.ok(r.dueAt && r.tier === 3);
  assert.equal(await sweepEscalations(new Date(Date.now() + 10_000)), 0); // هنوز مهلت نرسیده
  assert.equal(await sweepEscalations(new Date(Date.now() + 120_000)), 1);
  r = await Report.findById(res.json.id);
  assert.equal(r.tier, 2); assert.equal(r.escalations[0].auto, true);
});

test('پنجره‌ی بافت: ناظرِ ردیفِ ۳ فقط ۵ قبل/۵ بعد، مدیر کل؛ فهرستِ اعضا فقط برای دیدِ کامل', { skip: SKIP }, async () => {
  await Message.deleteMany({});
  const t0 = Date.now() - 100_000; const msgs = [];
  for (let i = 1; i <= 20; i += 1) msgs.push(await Message.create({ chat: chat._id, sender: [alice, bob][i % 2]._id, type: 'text', content: encryptText(`پیام ${i}`), createdAt: new Date(t0 + i * 1000) }));
  const rep = await Report.create({ reporter: alice._id, targetType: 'message', targetUser: bob._id, targetMessage: msgs[9]._id, category: 'harassment', chat: chat._id, tier: 3, assignedTo: mod3b._id });
  const m = await api(mod3b, 'GET', `/api/admin/moderation/cases/user/${rep._id}`);
  assert.equal(m.status, 200);
  const texts = m.json.serverMessages.map((x) => x.text);
  assert.deepEqual(texts, ['پیام 5', 'پیام 6', 'پیام 7', 'پیام 8', 'پیام 9', 'پیام 10', 'پیام 11', 'پیام 12', 'پیام 13', 'پیام 14', 'پیام 15']);
  assert.ok(!texts.includes('پیام 1') && !texts.includes('پیام 20')); // پیامِ دورتر نشت نمی‌کند
  assert.equal(m.json.serverMessages.find((x) => x.anchor).text, 'پیام 10');
  assert.deepEqual(m.json.members, []);
  const o = await api(owner, 'GET', `/api/admin/moderation/cases/user/${rep._id}`);
  assert.equal(o.json.serverMessages.length, 20); assert.equal(o.json.members.length, 3);
});

test('ناظر کلِ چت‌ها را مرور/جستجو نمی‌کند (۴۰۳)؛ مدیر می‌کند', { skip: SKIP }, async () => {
  for (const path of ['/api/admin/chats', `/api/admin/chats/${chat._id}/messages`, '/api/admin/messages/search?q=x']) {
    const m = await api(mod3, 'GET', path);
    assert.equal(m.status, 403, path); assert.equal(m.json.code, 'PERMISSION_DENIED');
    assert.equal((await api(owner, 'GET', path)).status, 200, path);
  }
});

test('مدیریتِ ادمین‌ها: ردیفِ جدید باید پایین‌تر، grant ⊆ دسترسیِ خود، نه روی خود، پایین‌ردیف‌ها مدیر نیستند', { skip: SKIP }, async () => {
  const P = (u, id, body) => api(u, 'PUT', `/api/admin/moderation/staff/${id}`, body);
  let r = await P(owner, alice._id, { level: 2 });
  assert.equal(r.status, 200); assert.equal(r.json.level, 2);
  assert.equal((await User.findById(alice._id)).role, 'moderator');
  assert.equal((await P(owner, owner._id, { level: 3 })).status, 403); // نه روی خود
  assert.equal((await P(deputy, bob._id, { level: 1 })).status, 403); // معاون نمی‌تواند هم‌ردیف بسازد
  assert.equal((await P(deputy, bob._id, { level: 0 })).status, 400); // ردیفِ ۰ ممنوع
  assert.equal((await P(deputy, bob._id, { level: 2, grant: ['keys.manage'] })).status, 403); // معاون keys.manage ندارد
  assert.equal((await P(deputy, bob._id, { level: 2, grant: ['chats.browse'] })).status, 200);
  assert.equal((await P(senior, carol._id, { level: 3 })).status, 403); // ردیفِ ۲ staff.manage ندارد
  assert.equal((await P(senior, deputy._id, { level: 3 })).status, 403);
  assert.equal((await P(deputy, owner._id, { level: 3 })).status, 403); // روی بالادستی نه
  r = await P(owner, alice._id, { level: null });
  assert.equal(r.json.level, null); assert.equal((await User.findById(alice._id)).role, 'user');
});

test('ویرایشِ ردیف‌ها: هم‌سطح/بالاتر قابل‌تغییر نیست؛ بیش از دسترسیِ خود نمی‌شود داد؛ ردیفِ دارای ادمین حذف نمی‌شود', { skip: SKIP }, async () => {
  const cur = (await api(owner, 'GET', '/api/admin/moderation/staff/tiers')).json.tiers;
  const put = (u, tiers) => api(u, 'PUT', '/api/admin/moderation/staff/tiers', { tiers });
  const edit = (lvl, f) => cur.map((t) => (t.level === lvl ? f({ ...t }) : t));
  assert.equal((await put(deputy, edit(1, (t) => ({ ...t, name: 'هک' })))).status, 403); // ردیفِ خودِ معاون
  assert.equal((await put(deputy, edit(3, (t) => ({ ...t, permissions: [...t.permissions, 'keys.manage'] })))).status, 403);
  assert.equal((await put(deputy, edit(3, (t) => ({ ...t, permissions: [...t.permissions, 'chats.browse'] })))).status, 200);
  assert.equal((await put(deputy, cur.filter((t) => t.level !== 3))).status, 409); // mod3 هنوز آن‌جاست
  assert.equal((await put(owner, cur.filter((t) => t.level !== 0))).status, 400); // ردیفِ ۰ باید باشد
  assert.equal((await put(owner, edit(0, (t) => ({ ...t, permissions: ['cases.decide'] })))).status, 200);
  const after = (await api(owner, 'GET', '/api/admin/moderation/staff/tiers')).json.tiers;
  assert.deepEqual(after.find((t) => t.level === 0).permissions, ['*']); // ردیفِ ۰ هرگز کاهش نمی‌یابد
});

test('سقفِ مدتِ محدودیت، نیاز به تأیید، و محدودیتِ دائمی', { skip: SKIP }, async () => {
  const d = (u, rec, body) => api(u, 'POST', `/api/admin/moderation/cases/ai/${rec._id}/decide`, body);
  let rec = await aiReport(carol, bob, 'sexual_harassment', box2([0, 2, 3]));
  await EncryptedReport.updateOne({ _id: rec._id }, { $set: { tier: 2 } });
  // ردیفِ ۲: سقف ۳۰ روز، دائمی ممنوع
  let r = await d(senior, rec, { decision: 'confirm', features: ['send_media'], days: 90 });
  assert.equal(r.status, 403); assert.equal(r.json.code, 'RESTRICT_CAP');
  r = await d(senior, rec, { decision: 'confirm', features: ['send_media'], days: 0 });
  assert.equal(r.status, 403);
  assert.equal((await EncryptedReport.findById(rec._id)).status, 'pending'); // رد‌شده‌ها چیزی را نهایی نکردند
  r = await d(senior, rec, { decision: 'confirm', features: ['send_media'], days: 7 });
  assert.equal(r.status, 200);
  // ردیفِ ۳: «تأیید» ندارد؛ فقط رد/زیرنظر
  rec = await aiReport(carol, alice, 'sexual_harassment');
  await EncryptedReport.updateOne({ _id: rec._id }, { $set: { tier: 3, assignedTo: mod3b._id } });
  r = await d(mod3b, rec, { decision: 'confirm' });
  assert.equal(r.status, 403); assert.equal(r.json.permission, 'cases.confirm');
  assert.equal((await d(mod3b, rec, { decision: 'dismiss' })).status, 200);
  // مدیر: دائمی مجاز
  rec = await aiReport(carol, alice, 'violence_threat');
  assert.equal((await d(owner, rec, { decision: 'confirm', features: ['calls'], days: 0 })).status, 200);
  const u = await User.findById(alice._id);
  assert.ok(u.restrictions.some((x) => x.features.includes('calls') && x.until === null));
});

test('تصمیمِ هم‌زمان: فقط یکی اثر می‌گذارد و شمارنده‌ی تأییدشده یک می‌شود', { skip: SKIP }, async (t) => {
  if (!dbAtomic) return t.skip('این دیتابیس (مثلاً FerretDB) به‌روزرسانیِ شرطیِ هم‌زمان را اتمیک نمی‌کند؛ روی MongoDB واقعی/Atlas اجرا کنید');
  const rec = await aiReport(carol, bob);
  const body = { decision: 'confirm', features: ['send_media'], days: 1 };
  const rs = await Promise.all([1, 2, 3].map(() => api(owner, 'POST', `/api/admin/moderation/cases/ai/${rec._id}/decide`, body)));
  assert.deepEqual(rs.map((x) => x.status).sort(), [200, 409, 409]);
  assert.equal((await User.findById(bob._id)).moderation.reportsAgainstConfirmed, 1);
});

test('آمارِ کاربر: گزارش‌های AI/کاربر × وضعیت × دسته', { skip: SKIP }, async () => {
  const a1 = await aiReport(carol, bob, 'sexual_harassment');
  const a2 = await aiReport(carol, bob, 'insult_hate');
  const u1 = await userReport(alice, bob, 'harassment');
  const D = (kind, rec, decision) => api(owner, 'POST', `/api/admin/moderation/cases/${kind}/${rec._id}/decide`, { decision, features: [], notifyUser: false });
  await D('ai', a1, 'confirm'); await D('ai', a2, 'dismiss'); await D('user', u1, 'confirm');
  const r = await api(owner, 'GET', `/api/admin/moderation/users/${bob._id}/moderation`);
  assert.equal(r.json.stats.ai.total, 2); assert.equal(r.json.stats.ai.confirmed, 1); assert.equal(r.json.stats.ai.dismissed, 1);
  assert.equal(r.json.stats.user.confirmed, 1);
  assert.equal(r.json.stats.confirmedByCategory.sexual_harassment, 1);
  assert.equal(r.json.stats.confirmedTotal, 2);
  assert.equal((await api(owner, 'GET', `/api/admin/moderation/cases/ai/${(await aiReport(alice, bob))._id}`)).json.stats.ai.total, 3); // آمار داخلِ جزئیاتِ پرونده هم هست
});

test('پلکانِ دسته‌دار: پله‌ی مخصوصِ دسته + پله‌ی عمومی هم‌زمان اعمال می‌شوند', { skip: SKIP }, async () => {
  await api(owner, 'PUT', '/api/admin/moderation/policy', { escalation: [{ confirmed: 1, features: ['send_media'], days: 1 }, { confirmed: 1, category: 'violence_threat', features: ['calls'], days: 3 }] });
  const rec = await aiReport(carol, bob, 'violence_threat');
  const r = await api(owner, 'POST', `/api/admin/moderation/cases/ai/${rec._id}/decide`, { decision: 'confirm', features: [], notifyUser: false });
  assert.equal(r.status, 200);
  const feats = (await User.findById(bob._id)).restrictions.flatMap((x) => x.features).sort();
  assert.deepEqual(feats, ['calls', 'send_media']);
  // دسته‌ی دیگر: فقط پله‌ی عمومی
  const rec2 = await aiReport(carol, alice, 'insult_hate');
  await api(owner, 'POST', `/api/admin/moderation/cases/ai/${rec2._id}/decide`, { decision: 'confirm', features: [], notifyUser: false });
  assert.deepEqual((await User.findById(alice._id)).restrictions.flatMap((x) => x.features), ['send_media']);
});

test('گزارشِ کاربر با دسته‌ی نامعتبر ۴۰۰ می‌دهد (نه ۵۰۰)', { skip: SKIP }, async () => {
  const r = await api(alice, 'POST', '/api/reports', { targetType: 'user', targetUserId: String(bob._id), category: 'nonsense' });
  assert.equal(r.status, 400);
  assert.equal(await Report.countDocuments({}), 0);
});

test('sealedContextِ گزارشِ کاربر: معتبر (v1/v2) ذخیره می‌شود، آشغال/ناقص دور ریخته می‌شود', { skip: SKIP }, async () => {
  const send = async (sealedContext, cat) => {
    const r = await api(alice, 'POST', '/api/reports', { targetType: 'user', targetUserId: String(bob._id), category: cat, sealedContext });
    assert.equal(r.status, 201); const rec = await Report.findById(r.json.id); await Report.deleteMany({}); return rec.sealedContext;
  };
  assert.equal((await send(box2([0, 2]), 'spam')).v, 2);
  assert.equal((await send(box1(), 'spam')).v, 1);
  assert.equal(await send({ ciphertext: 'x'.repeat(10), evil: { $gt: '' } }, 'spam'), null);
  assert.equal(await send({ v: 2, keys: [{ level: 2 }] }, 'spam'), null);
  assert.equal(await send('نه-شیء', 'spam'), null);
});

test('زیرنظرِ خودکار: N گزارش ⇒ فقط پرچم، هیچ محدودیتِ خودکاری', { skip: SKIP }, async () => {
  await updateSettings({ moderationPolicy: { watch: { reports: 3, days: 30 } } });
  for (let i = 0; i < 3; i += 1) {
    const reporter = [alice, carol, owner][i];
    await api(reporter, 'POST', '/api/reports', { targetType: 'user', targetUserId: String(bob._id), category: ['spam', 'harassment', 'fraud'][i] });
  }
  const b = await User.findById(bob._id);
  assert.equal(b.moderation.underReview, true); assert.equal(b.restrictions.length, 0);
  const w = await api(owner, 'GET', '/api/admin/moderation/watchlist');
  assert.ok(w.json.some((x) => x.username === 'bob'));
});

test('تابلو: تعدادِ ادمین/آنلاین/بار/بی‌مسئول در هر ردیف', { skip: SKIP }, async () => {
  await User.updateOne({ _id: mod3b._id }, { $set: { isOnline: true } });
  await api(alice, 'POST', '/api/reports', { targetType: 'user', targetUserId: String(bob._id), category: 'spam' });
  await User.updateOne({ _id: mod3b._id }, { $set: { isOnline: false } });
  await api(alice, 'POST', '/api/reports', { targetType: 'user', targetUserId: String(carol._id), category: 'fraud' });
  const b = (await api(owner, 'GET', '/api/admin/moderation/staff/board')).json.board;
  const t3 = b.find((x) => x.level === 3);
  assert.equal(t3.total, 2); assert.equal(t3.online, 0); assert.equal(t3.open, 2); assert.equal(t3.unassigned, 1);
  assert.equal(b.find((x) => x.level === 0).total, 1);
  assert.equal((await api(mod3, 'GET', '/api/admin/moderation/staff/board')).status, 403); // ردیفِ ۳ تابلو را نمی‌بیند
});

test('نمای پرونده: بدونِ دسترسی ۴۰۴؛ گزارش‌دهنده‌ی AI برای ردیف‌های غیرکامل پنهان؛ فقط ورودیِ مهروموم مالِ ردیفِ خود', { skip: SKIP }, async () => {
  const rec = await aiReport(carol, bob, 'sexual_harassment', box2([0, 2, 3]));
  await EncryptedReport.updateOne({ _id: rec._id }, { $set: { tier: 2, assignedTo: senior._id } });
  const s = await api(senior, 'GET', `/api/admin/moderation/cases/ai/${rec._id}`);
  assert.equal(s.status, 200);
  assert.equal(s.json.sealedBox.keys.length, 1); assert.equal(s.json.sealedBox.keys[0].level, 2);
  assert.equal(s.json.sealedBox.ciphertext, B('payloadct')); assert.equal(s.json.sealedBox.nonce, B('payloadnonce')); // محتوای رمزشده هم باید برسد، وگرنه کلید به‌تنهایی بی‌فایده است
  assert.equal(s.json.case.reporter, undefined);
  assert.equal(s.json.case.sealedBox, undefined);
  const o = await api(owner, 'GET', `/api/admin/moderation/cases/ai/${rec._id}`);
  assert.equal(o.json.sealedBox.keys[0].level, 0); assert.equal(String(o.json.case.reporter._id || o.json.case.reporter), String(carol._id));
  assert.equal((await api(mod3b, 'GET', `/api/admin/moderation/cases/ai/${rec._id}`)).status, 404); // ردیفِ ۳ این را نمی‌بیند
  // v1 فقط مدیر اصلی
  const v1 = await aiReport(carol, bob, 'x', box1());
  await EncryptedReport.updateOne({ _id: v1._id }, { $set: { tier: 2 } });
  assert.equal((await api(senior, 'GET', `/api/admin/moderation/cases/ai/${v1._id}`)).json.sealedBox, null);
  assert.equal((await api(owner, 'GET', `/api/admin/moderation/cases/ai/${v1._id}`)).json.sealedBox.v, 1);
});

test('ثبتِ گزارشِ رمزشده: v1/v2، ردیفِ ۰ الزامی، تکراری/خراب/بیش‌ازحد ⇒ ۴۰۰، گزارش‌دهنده ثبت می‌شود', { skip: SKIP }, async () => {
  await updateSettings({ adminReportPublicKey: B('adminpk') });
  const post = (u, body) => api(u, 'POST', '/api/moderation/reports/encrypted', { chatId: String(chat._id), category: 'sexual_harassment', accusedUserId: String(bob._id), ...body });
  assert.equal((await post(alice, { sealedBox: box1() })).status, 200);
  assert.equal((await post(alice, { category: 'violence_threat', sealedBox: box2([0, 2]) })).status, 200); // دسته‌ی دیگر ⇒ پروندهٔ جدا
  assert.equal((await post(alice, { sealedBox: box2([2, 3]) })).status, 400); // بدونِ ردیفِ ۰
  assert.equal((await post(alice, { sealedBox: { ...box2([0]), keys: [...box2([0]).keys, ...box2([0]).keys] } })).status, 400); // ردیفِ تکراری
  assert.equal((await post(alice, { sealedBox: box2([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9]) })).status, 400); // >۱۰ کلید
  assert.equal((await post(alice, { sealedBox: { ...box1(), ciphertext: '!!notbase64!!' } })).status, 400);
  assert.equal((await post(alice, { sealedBox: { v: 3 } })).status, 400);
  const outsider = await User.create({ username: 'dave', displayName: 'dave', passwordHash: 'x' });
  assert.equal((await post(outsider, { sealedBox: box1() })).status, 403); // عضو چت نیست
  const recs = await EncryptedReport.find({});
  assert.equal(recs.length, 2); assert.ok(recs.every((r) => String(r.reporter) === String(alice._id)));
  assert.ok(recs.every((r) => r.tier === 3)); // هوکِ مسیریابی اجرا شده
  // خودِ گزارش‌دهنده متهم نمی‌شود (فقط گوشیِ طرفِ مقابل گزارش می‌دهد)؛ غیرعضو هم نمی‌تواند متهم شود
  const before = await EncryptedReport.countDocuments({});
  assert.equal((await post(alice, { sealedBox: box1(), accusedUserId: String(alice._id) })).status, 400);
  const dave = await User.findOne({ username: 'dave' });
  await post(alice, { sealedBox: box1(), category: 'insult_hate', accusedUserId: String(dave._id) });
  assert.equal(await EncryptedReport.countDocuments({ accusedUser: dave._id }), 0);
  assert.equal(await EncryptedReport.countDocuments({ accusedUser: alice._id }), 0);
  assert.ok((await EncryptedReport.countDocuments({})) <= before + 1); // حداکثر همان یکی بدونِ متهم
});

test('محدودیتِ نرخِ گزارشِ رمزشده: ۴۰ در ساعت', { skip: SKIP }, async () => {
  await updateSettings({ adminReportPublicKey: B('adminpk') });
  await EncryptedReport.insertMany(Array.from({ length: 40 }, () => ({ chat: chat._id, reporter: carol._id, category: 'x', sealedBox: { v: 1, ...box1() } })));
  const r = await api(carol, 'POST', '/api/moderation/reports/encrypted', { chatId: String(chat._id), sealedBox: box1() });
  assert.equal(r.status, 429);
  assert.equal((await api(alice, 'POST', '/api/moderation/reports/encrypted', { chatId: String(chat._id), sealedBox: box1() })).status, 200); // کاربرِ دیگر مشکلی ندارد
});

test('کلیدها: گیرنده‌ها در /admin-key، افزایشِ خودکارِ نسخه، فقط دارنده‌ی keys.manage، کلیدِ شخصیِ ناظر، کلیدِ بسته‌شده', { skip: SKIP }, async () => {
  await updateSettings({ adminReportPublicKey: B('adminpk'), moderationRouting: { initialTier: 3 } });
  const k1 = B('tier3key');
  assert.equal((await api(deputy, 'PUT', '/api/admin/moderation/tier-keys', { keys: { 3: { publicKey: k1 } } })).status, 403);
  let r = await api(owner, 'PUT', '/api/admin/moderation/tier-keys', { keys: { 3: { publicKey: k1 }, 2: { publicKey: B('t2') } } });
  assert.equal(r.status, 200); assert.equal(r.json.keys['3'].version, 1);
  assert.equal((await api(owner, 'PUT', '/api/admin/moderation/tier-keys', { keys: { 3: { publicKey: k1 } } })).json.keys['3'].version, 1); // بدونِ تغییر ⇒ همان نسخه
  assert.equal((await api(owner, 'PUT', '/api/admin/moderation/tier-keys', { keys: { 3: { publicKey: B('rotated') } } })).json.keys['3'].version, 2);
  assert.equal((await api(owner, 'PUT', '/api/admin/moderation/tier-keys', { keys: { 3: { publicKey: '!!' } } })).status, 400);
  assert.equal((await api(owner, 'PUT', '/api/admin/moderation/tier-keys', { keys: { 7: { publicKey: k1 } } })).status, 400); // ردیفِ ناموجود
  const ak = await api(alice, 'GET', '/api/moderation/admin-key');
  assert.deepEqual(ak.json.recipients.map((x) => x.level), [0, 2, 3]); // ردیفِ ۱ کلید ندارد ⇒ نیست
  assert.equal(ak.json.recipients.find((x) => x.level === 3).version, 2);
  // کلیدِ شخصیِ ناظر + کلیدِ بسته‌شده
  assert.equal((await api(mod3b, 'PUT', '/api/admin/moderation/staff/me/key', { publicKey: B('personal') })).status, 200);
  assert.equal((await api(owner, 'GET', `/api/admin/moderation/staff/${mod3b._id}/public-key`)).json.publicKey, B('personal'));
  assert.equal((await api(mod3b, 'GET', `/api/admin/moderation/staff/${mod3b._id}/public-key`)).status, 403);
  assert.equal((await api(owner, 'PUT', `/api/admin/moderation/staff/${mod3b._id}/wrapped-keys`, { keys: [{ level: 2, sealed: { ct: 'x' } }] })).status, 400); // کلیدِ ردیفِ بالاتر از او
  assert.equal((await api(owner, 'PUT', `/api/admin/moderation/staff/${mod3b._id}/wrapped-keys`, { keys: [{ level: 3, version: 2, sealed: { ephemeralPublicKey: 'a', nonce: 'b', ciphertext: 'c' } }] })).status, 200);
  const mine = await api(mod3b, 'GET', '/api/admin/moderation/staff/me/keys');
  assert.equal(mine.json.level, 3); assert.equal(mine.json.wrappedKeys.length, 1); assert.equal(mine.json.wrappedKeys[0].version, 2);
  // ردیفِ ۱: اگر ردیفِ اولیه بالاتر برود recipients تا همان ردیف می‌رود
  await updateSettings({ moderationRouting: { initialTier: 2 } });
  assert.deepEqual((await api(alice, 'GET', '/api/moderation/admin-key')).json.recipients.map((x) => x.level), [0, 2]);
});

test('مدلِ هر زبان: بدونِ فال‌بکِ فارسی', { skip: SKIP }, async () => {
  await ModerationModel.deleteMany({});
  await ModerationModel.create({ key: 'fa', version: 4, labels: ['normal', 'sexual_harassment'], modelJson: JSON.stringify({ ok: 1 }) });
  const v = (lang) => api(alice, 'GET', `/api/moderation/model/version${lang ? `?lang=${lang}` : ''}`);
  assert.deepEqual((await v('fa')).json, { version: 4, lang: 'fa' });
  assert.deepEqual((await v('ar')).json, { version: 0, lang: null }); // قبلاً مدلِ فارسی برمی‌گشت ⇒ گزارشِ اشتباه روی عربی
  assert.deepEqual((await v()).json, { version: 4, lang: 'fa' }); // کلاینتِ قدیمی بدونِ lang
  assert.equal((await api(alice, 'GET', '/api/moderation/model?lang=tr')).status, 404);
  assert.equal((await api(alice, 'GET', '/api/moderation/model?lang=fa')).json.lang, 'fa');
});

test('ناظر روی ادمین/ارشدتر اقدام نمی‌کند (تصمیم/محدودیت/تعلیق)', { skip: SKIP }, async () => {
  const rec = await aiReport(carol, senior, 'sexual_harassment'); // متهم = ناظرِ ارشد
  await EncryptedReport.updateOne({ _id: rec._id }, { $set: { tier: 3, assignedTo: mod3b._id } });
  const r = await api(mod3b, 'POST', `/api/admin/moderation/cases/ai/${rec._id}/decide`, { decision: 'dismiss' });
  assert.equal(r.status, 403); assert.equal((await EncryptedReport.findById(rec._id)).status, 'pending');
  assert.equal((await api(senior, 'POST', `/api/admin/moderation/users/${deputy._id}/restrictions`, { features: ['calls'], days: 1 })).status, 403);
  assert.equal((await api(senior, 'POST', `/api/admin/users/${deputy._id}/suspend`, { hours: 1 })).status, 403);
  assert.equal((await api(senior, 'POST', `/api/admin/users/${bob._id}/suspend`, { hours: 24 * 60 })).status, 403); // از سقفِ ۳۰ روز بیشتر
  assert.equal((await api(senior, 'POST', `/api/admin/users/${bob._id}/suspend`, { hours: 24 })).status, 200);
  assert.equal((await api(deputy, 'POST', `/api/admin/moderation/users/${senior._id}/restrictions`, { features: ['calls'], days: 1 })).status, 200); // معاون روی پایین‌تر می‌تواند
});

test('PUT /policy: scopes (enabled/minConfidence) واقعاً ذخیره می‌شوند؛ serious/dedupeMinutes هم؛ مقدارِ خراب پاک‌سازی می‌شود', { skip: SKIP }, async () => {
  const put = (b) => api(owner, 'PUT', '/api/admin/moderation/policy', b);
  const r = await put({
    scopes: { private: { insult_hate: { enabled: true, minConfidence: '0.9' }, violence_threat: { enabled: false, minConfidence: 0.3 }, 'bad key!': { enabled: true } }, group: { sexual_content: { enabled: true, minConfidence: 5 } }, evil: { x: 1 } },
    serious: ['violence_threat', 'bad key!', 7], dedupeMinutes: 30,
  });
  assert.equal(r.status, 200);
  const g = (await api(owner, 'GET', '/api/admin/moderation/policy')).json.policy;
  assert.deepEqual(g.scopes.private.insult_hate, { enabled: true, minConfidence: 0.9 }); // رشته ← عدد
  assert.deepEqual(g.scopes.private.violence_threat, { enabled: false, minConfidence: 0.5 }); // کفِ ۰٫۵
  assert.deepEqual(g.scopes.group.sexual_content, { enabled: true, minConfidence: 0.99 });   // سقفِ ۰٫۹۹
  assert.equal(g.scopes.private['bad key!'], undefined);
  assert.deepEqual(g.serious, ['violence_threat']); assert.equal(g.dedupeMinutes, 30);
  assert.equal((await api(deputy, 'PUT', '/api/admin/moderation/policy', { dedupeMinutes: 5 })).status, 200); // معاون policy.edit دارد
  assert.equal((await api(mod3, 'PUT', '/api/admin/moderation/policy', { dedupeMinutes: 5 })).status, 403);
});

test('گروه: گزارش‌های تکراریِ همان چت/متهم/دسته یک پرونده می‌شوند؛ دسته‌ی دیگر یا بعد از نهایی‌شدن پروندهٔ جدید', { skip: SKIP }, async () => {
  await updateSettings({ adminReportPublicKey: B('adminpk') });
  const post = (u, body) => api(u, 'POST', '/api/moderation/reports/encrypted', { chatId: String(chat._id), category: 'violence_threat', accusedUserId: String(bob._id), sealedBox: box2([0, 3]), ...body });
  const exists = (u, cat = 'violence_threat') => api(u, 'GET', `/api/moderation/reports/exists?chatId=${chat._id}&accusedUserId=${bob._id}&category=${cat}`);
  assert.equal((await exists(alice)).json.exists, false);
  assert.equal((await post(alice, {})).json.duplicate, undefined);          // اولی پرونده می‌سازد
  assert.equal((await exists(carol)).json.exists, true);                    // گوشیِ عضوِ دیگر قبل از رمزکردن می‌پرسد
  assert.equal((await exists(carol, 'insult_hate')).json.exists, false);
  const d1 = await post(carol, {}); assert.equal(d1.json.duplicate, true);   // دومی ملحق می‌شود
  assert.equal((await post(owner, {})).status, 403);                         // غیرعضو (owner عضوِ این چت نیست)
  assert.equal(await EncryptedReport.countDocuments({}), 1);
  const rec = await EncryptedReport.findOne({}); assert.equal(rec.dupCount, 1);
  assert.equal((await User.findById(bob._id)).moderation.reportsAgainst, 1); // شمارنده فقط یک‌بار (وگرنه گزارش‌های انبوه سلاح می‌شد)
  const list = (await api(owner, 'GET', '/api/admin/moderation/cases?status=pending')).json;
  assert.equal(list.length, 1); assert.equal(list[0].dupCount, 1);
  assert.equal((await post(carol, { category: 'insult_hate' })).json.duplicate, undefined); // دسته‌ی دیگر = پروندهٔ جدا
  await EncryptedReport.updateOne({ _id: rec._id }, { $set: { status: 'dismissed' } });
  assert.equal((await exists(alice)).json.exists, false);                    // پروندهٔ نهایی‌شده دیگر «موجود» نیست
  assert.equal((await post(alice, {})).json.duplicate, undefined);
  assert.equal(await EncryptedReport.countDocuments({ category: 'violence_threat' }), 2);
  await updateSettings({ moderationPolicy: { dedupeMinutes: 0 } });          // خاموش‌کردنِ یکی‌سازی
  assert.equal((await post(carol, {})).json.duplicate, undefined);
  assert.equal(await EncryptedReport.countDocuments({ category: 'violence_threat' }), 3);
  const outsider = await User.create({ username: 'erin', displayName: 'erin', passwordHash: 'x' });
  assert.equal((await exists(outsider)).json.exists, false);                 // غیرِ عضو چیزی نمی‌فهمد
});

test('پلکان: پیش‌نمایشِ «اگر تأیید شود» + «یک پله بالاتر»؛ تأیید همان را اعمال می‌کند؛ ادمین می‌تواند بیشتر از پله بدهد', { skip: SKIP }, async () => {
  const rec = await aiReport(carol, bob, 'violence_threat');
  const det = (await api(owner, 'GET', `/api/admin/moderation/cases/ai/${rec._id}`)).json;
  const will = det.ladder.willApply.flatMap((a) => a.features);
  assert.ok(will.includes('calls') && will.includes('new_chats') && will.includes('send_media')); // تهدیدِ اول + پلهٔ عمومیِ اول
  assert.equal(det.ladder.higher.category, 'violence_threat'); assert.equal(det.ladder.higher.confirmed, 2);
  assert.equal((await api(mod3, 'GET', `/api/admin/moderation/cases/ai/${rec._id}`)).json.ladder, undefined); // ردیفِ ۳ تأیید ندارد ⇒ پیش‌نمایش هم ندارد
  // تأیید بدونِ محدودیتِ دستی ⇒ دقیقاً همان پیش‌نمایش اعمال می‌شود
  assert.equal((await api(owner, 'POST', `/api/admin/moderation/cases/ai/${rec._id}/decide`, { decision: 'confirm', features: [], notifyUser: false })).status, 200);
  const after = (await User.findById(bob._id)).restrictions.flatMap((x) => x.features).sort();
  assert.deepEqual(after, [...new Set(will)].sort());
  // پروندهٔ دوم: پیش‌نمایش از همین حالا «پله‌ی ۲» را می‌دهد؛ ادمین حتی بیشتر (دائمی) می‌دهد
  const rec2 = await aiReport(carol, bob, 'violence_threat');
  const det2 = (await api(owner, 'GET', `/api/admin/moderation/cases/ai/${rec2._id}`)).json;
  assert.ok(det2.ladder.willApply.some((a) => a.category === 'violence_threat' && a.confirmed === 2));
  const r = await api(owner, 'POST', `/api/admin/moderation/cases/ai/${rec2._id}/decide`, { decision: 'confirm', features: ['send_messages', 'profile_edit'], days: 0, notifyUser: false });
  assert.equal(r.status, 200);
  const perm = (await User.findById(bob._id)).restrictions.find((x) => x.features.includes('profile_edit'));
  assert.ok(perm && perm.until === null); // «بیشتر از پله»: ویژگیِ بیرون از پلکان + دائمی
  // ردیفِ ۲ همین کار را نمی‌تواند (دائمی ممنوع) ولی تا سقفِ خودش بیشتر از پله می‌تواند
  const rec3 = await aiReport(carol, alice, 'violence_threat');
  await EncryptedReport.updateOne({ _id: rec3._id }, { $set: { tier: 2 } });
  assert.equal((await api(senior, 'POST', `/api/admin/moderation/cases/ai/${rec3._id}/decide`, { decision: 'confirm', features: ['profile_edit'], days: 0, notifyUser: false })).status, 403);
  assert.equal((await api(senior, 'POST', `/api/admin/moderation/cases/ai/${rec3._id}/decide`, { decision: 'confirm', features: ['profile_edit'], days: 30, notifyUser: false })).status, 200);
});

test('نمونه‌ی آموزشی: برچسب را سرور از نتیجه‌ی پرونده می‌سازد؛ فقط تصمیم‌گیرنده؛ بدونِ شناسه؛ upsert؛ قابل‌خاموش‌کردن', { skip: SKIP }, async () => {
  const sample = (u, body) => api(u, 'POST', '/api/admin/moderation/samples', body);
  const D = (rec, decision) => api(owner, 'POST', `/api/admin/moderation/cases/ai/${rec._id}/decide`, { decision, features: [], notifyUser: false });
  const a = await aiReport(carol, bob, 'violence_threat'); const b = await aiReport(carol, alice, 'insult_hate'); const open = await aiReport(carol, bob, 'sexual_content');
  await D(a, 'confirm'); await D(b, 'dismiss');
  assert.equal((await sample(owner, { id: String(open._id), text: 'x', confidence: 0.9 })).status, 409); // هنوز نهایی نشده
  assert.equal((await sample(deputy, { id: String(a._id), text: 'جعلی', confidence: 0.9 })).status, 403); // تصمیم‌گیرنده owner بود
  assert.equal((await sample(owner, { id: String(a._id), text: '   ' })).status, 400);
  assert.equal((await sample(owner, { id: 'nope', text: 'x' })).status, 400);
  assert.equal((await sample(owner, { id: String(a._id), text: 'می‌کشمت\u0000\u0007 فردا', confidence: 1.7, lang: 'fa' })).json.ok, true);
  assert.equal((await sample(owner, { id: String(b._id), text: 'ساعت هشت جلسه داریم', confidence: 0.91, lang: 'xx-bad' })).json.ok, true);
  const rows = await TrainingSample.find({}).sort({ label: 1 });
  assert.equal(rows.length, 2);
  const normal = rows.find((r) => r.label === 'normal'); const harm = rows.find((r) => r.label === 'violence_threat');
  assert.equal(normal.reportedCategory, 'insult_hate'); assert.equal(normal.lang, 'fa'); assert.equal(harm.confidence, 1); assert.equal(harm.text, 'می‌کشمت   فردا'); // دو کاراکترِ کنترلی ⇒ دو فاصله + فاصله‌ی خودِ متن
  assert.equal(Object.keys(normal.toObject()).some((k) => ['user', 'chat', 'accusedUser', 'reporter'].includes(k)), false); // هیچ شناسه‌ای ذخیره نمی‌شود
  await sample(owner, { id: String(a._id), text: 'ویرایش‌شده', confidence: 0.5 }); // دوباره = جایگزین، نه تکرار
  assert.equal(await TrainingSample.countDocuments({}), 2);
  await api(owner, 'PUT', '/api/admin/moderation/policy', { training: { enabled: false } });
  assert.equal((await sample(owner, { id: String(b._id), text: 'x' })).json.skipped, 'disabled');
  await api(owner, 'PUT', '/api/admin/moderation/policy', { training: { enabled: true, minSamples: 1, targetPrecision: 5, retentionDays: 0 } });
  const t = (await api(owner, 'GET', '/api/admin/moderation/policy')).json.policy.training;
  assert.equal(t.enabled, true); assert.equal(t.minSamples, 10); assert.equal(t.targetPrecision, 0.99); assert.equal(t.retentionDays, 1); // مرزها
});

test('کالیبراسیون: از تصمیم‌های واقعی آستانه را تنظیم می‌کند؛ فقط دسته‌ی فعال؛ فقط policy.edit؛ export فقط models.manage', { skip: SKIP }, async () => {
  await api(owner, 'PUT', '/api/admin/moderation/policy', {
    scopes: { private: { insult_hate: { enabled: true, minConfidence: 0.7 }, violence_threat: { enabled: true, minConfidence: 0.9 } }, group: { insult_hate: { enabled: true, minConfidence: 0.7 }, sexual_content: { enabled: false, minConfidence: 0.8 } } }, // sexual_content در پیش‌فرض فقط در گروه فعال است؛ اینجا خاموش
    training: { minSamples: 30, targetPrecision: 0.8 },
  });
  // insult_hate: فقط اطمینانِ ≥۰٫۹۲ درست است (۸۰ نمونه)؛ violence_threat همه‌جا دقیق؛ sexual_content آستانه‌ی فعال ندارد
  const mk = (cat, n, conf, ok) => Array.from({ length: n }, (_, i) => ({ caseId: new mongoose.Types.ObjectId(), text: `t${cat}${i}`, label: ok(i) ? cat : 'normal', reportedCategory: cat, confidence: conf(i), lang: 'fa' }));
  await TrainingSample.insertMany([
    ...mk('insult_hate', 80, (i) => 0.6 + (0.4 * i) / 79, (i) => 0.6 + (0.4 * i) / 79 >= 0.92),
    ...mk('violence_threat', 60, (i) => 0.6 + (0.4 * i) / 59, () => true),
    ...mk('sexual_content', 60, (i) => 0.6 + (0.4 * i) / 59, () => true),
  ]);
  assert.equal((await api(mod3, 'GET', '/api/admin/moderation/calibration')).status, 403);
  const dry = (await api(owner, 'GET', '/api/admin/moderation/calibration')).json;
  assert.equal(dry.total, 200);
  const by = Object.fromEntries(dry.results.map((r) => [r.category, r]));
  assert.ok(by.insult_hate.suggested > 0.7); assert.ok(by.violence_threat.suggested < 0.9);
  const pol0 = (await api(owner, 'GET', '/api/admin/moderation/policy')).json.policy.scopes;
  assert.equal(pol0.private.insult_hate.minConfidence, 0.7); // GET فقط پیشنهاد است
  const run = (await api(owner, 'POST', '/api/admin/moderation/calibration/run', {})).json;
  assert.ok(run.changes.some((c) => c.category === 'insult_hate') && run.changes.some((c) => c.category === 'violence_threat'));
  assert.equal(run.changes.some((c) => c.category === 'sexual_content'), false); // دسته‌ی غیرفعال (هر دو scope) دست‌نخورده
  assert.equal((await api(owner, 'GET', '/api/admin/moderation/policy')).json.policy.scopes.group.sexual_content.minConfidence, 0.8);
  const pol1 = (await api(owner, 'GET', '/api/admin/moderation/policy')).json.policy.scopes;
  assert.ok(pol1.private.insult_hate.minConfidence > 0.7 && pol1.group.insult_hate.minConfidence === pol1.private.insult_hate.minConfidence);
  assert.ok(pol1.private.violence_threat.minConfidence < 0.9 && pol1.private.violence_threat.minConfidence >= 0.8 - 1e-9); // حداکثر یک گام
  assert.deepEqual(pol1.private.sexual_content, { enabled: false, minConfidence: 0.9 }); // پیش‌فرضِ غیرفعال، دست‌نخورده
  assert.equal((await api(deputy, 'GET', '/api/admin/moderation/samples/export')).status, 403);
  const ex = (await api(owner, 'GET', '/api/admin/moderation/samples/export?lang=fa')).json;
  assert.equal(ex.count, 200); assert.deepEqual(Object.keys(ex.samples[0]).sort(), ['confidence', 'label', 'lang', 'reportedCategory', 'text']);
  const { purgeOldSamples } = require('../src/utils/trainingJobs');
  await TrainingSample.collection.updateMany({ reportedCategory: 'sexual_content' }, { $set: { createdAt: new Date(Date.now() - 400 * 86400000) } }); // createdAt در mongoose immutable است ⇒ درایورِ خام
  assert.equal(await purgeOldSamples(), 60); // retentionDays پیش‌فرض ۳۶۵
});
