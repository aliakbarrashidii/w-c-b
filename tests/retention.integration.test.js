// تست یکپارچه‌ی نگهداری جداگانه‌ی هر نوع رسانه (دیتابیس واقعی): نوع «موسیقی» (audio) مستقل از «ویس» و «فایل» است.
// اجرا:  TEST_MONGO_URI=mongodb://127.0.0.1:27017 node --test --test-force-exit tests/retention.integration.test.js
process.env.JWT_SECRET = 'test-secret';
process.env.MESSAGE_ENCRYPTION_KEY = 'b'.repeat(64);

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const SKIP = process.env.TEST_MONGO_URI ? false : 'TEST_MONGO_URI تنظیم نشده';
let Message; let Settings; let updateSettings; let runRetentionCleanup;
const chat = new mongoose.Types.ObjectId();
const sender = new mongoose.Types.ObjectId();
const H = 3600 * 1000;
const mk = (type, hoursAgoDelivered) => Message.create({
  chat, sender, type, content: type === 'text' ? 'hi' : '', mediaUrl: type === 'text' ? '' : `/uploads/${type}-${Math.random()}.bin`,
  fullyDeliveredAt: new Date(Date.now() - hoursAgoDelivered * H),
});
const alive = async (m) => !!(await Message.exists({ _id: m._id }));

test.before(async () => {
  if (SKIP) return;
  await mongoose.connect(process.env.TEST_MONGO_URI, { dbName: `wizret_${Date.now()}` });
  Message = require('../src/models/Message');
  Settings = require('../src/models/Settings');
  ({ updateSettings } = require('../src/utils/settings'));
  ({ runRetentionCleanup } = require('../src/utils/messageRetentionJob'));
  await Promise.all([Message, Settings].map((M) => M.init().catch(() => {})));
});
test.after(async () => {
  if (SKIP) return;
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
});

test('موسیقی (audio) زمان نگهداری جدای خودش را دارد؛ ویس/فایل/متن دست‌نخورده می‌مانند', { skip: SKIP }, async () => {
  await updateSettings({ messageRetentionSec: 7 * 86400, undeliveredMaxWaitSec: 30 * 86400 });
  await updateSettings({ 'mediaRetentionSec.audio': 3600, 'mediaRetentionSec.file': 3 * 86400 }); // موسیقی ۱ ساعت، فایل ۳ روز
  const audioOld = await mk('audio', 2);   // ۲ ساعت پیش تحویل شده → باید پاک شود
  const audioNew = await mk('audio', 0.5); // نیم ساعت پیش → می‌ماند
  const fileOld = await mk('file', 2);     // سقف فایل ۳ روز است → می‌ماند
  const voice = await mk('voice', 2);      // override ندارد → پیش‌فرض ۷ روز → می‌ماند
  const text = await mk('text', 2);        // پیش‌فرض → می‌ماند
  await runRetentionCleanup();
  assert.equal(await alive(audioOld), false, 'موسیقیِ قدیمی باید پاک شود');
  assert.equal(await alive(audioNew), true);
  assert.equal(await alive(fileOld), true);
  assert.equal(await alive(voice), true);
  assert.equal(await alive(text), true);
});

test('نوع بدون override از نگهداری پیش‌فرض پیروی می‌کند؛ با برداشتن override موسیقی هم پیش‌فرض می‌شود', { skip: SKIP }, async () => {
  await updateSettings({ 'mediaRetentionSec.audio': null });
  const audio = await mk('audio', 24 * 8); // ۸ روز پیش؛ پیش‌فرض ۷ روز → باید پاک شود
  const recent = await mk('audio', 24 * 6); // ۶ روز → می‌ماند
  await runRetentionCleanup();
  assert.equal(await alive(audio), false);
  assert.equal(await alive(recent), true);
});

test('پیام‌های نرسیده (تحویل‌نشده) مستقل از نوع با سقف انتظار پاک می‌شوند', { skip: SKIP }, async () => {
  const old = await Message.create({ chat, sender, type: 'audio', mediaUrl: '/uploads/x.bin', fullyDeliveredAt: null });
  await Message.collection.updateOne({ _id: old._id }, { $set: { createdAt: new Date(Date.now() - 31 * 86400 * 1000) } });
  await runRetentionCleanup();
  assert.equal(await alive(old), false);
});
