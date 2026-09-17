const express = require('express');
const Device = require('../models/Device');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// دستگاه، کلیدهای عمومی‌ش رو (Identity/SignedPrekey/OneTimePrekeys) اینجا ثبت/به‌روز می‌کنه.
// خودِ کلیدهای خصوصی هیچ‌وقت به سرور فرستاده نمی‌شن - این فقط نیم‌ی عمومیه.
router.post('/register', requireAuth, async (req, res) => {
  const {
    deviceId,
    platform,
    identityKeyPub,
    identitySignKeyPub,
    signedPrekeyId,
    signedPrekeyPub,
    signedPrekeySig,
    oneTimePrekeys,
  } = req.body;
  if (!deviceId || !identityKeyPub || !identitySignKeyPub || !signedPrekeyPub || !signedPrekeySig) {
    return res.status(400).json({ error: 'فیلدهای لازم برای ثبت دستگاه ارسال نشده' });
  }
  const device = await Device.findOneAndUpdate(
    { user: req.user._id, deviceId },
    {
      user: req.user._id,
      deviceId,
      platform: platform || 'android',
      identityKeyPub,
      identitySignKeyPub,
      signedPrekeyId,
      signedPrekeyPub,
      signedPrekeySig,
      $push: { oneTimePrekeys: { $each: oneTimePrekeys || [] } },
      lastSeenAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  res.json({ ok: true, deviceId: device.deviceId });
});

// وقتی موجودی OneTimePrekeyها روی گوشی کم شد، دسته‌ی جدید اضافه می‌کنه (بدون لمس بقیه‌ی فیلدها)
router.post('/:deviceId/replenish-prekeys', requireAuth, async (req, res) => {
  const { oneTimePrekeys } = req.body;
  if (!Array.isArray(oneTimePrekeys) || !oneTimePrekeys.length) {
    return res.status(400).json({ error: 'لیست کلید ارسال نشده' });
  }
  await Device.updateOne(
    { user: req.user._id, deviceId: req.params.deviceId },
    { $push: { oneTimePrekeys: { $each: oneTimePrekeys } } }
  );
  res.json({ ok: true });
});

// تعداد پیش‌کلیدهای یک‌بارمصرفِ باقی‌مونده - کلاینت دوره‌ای این رو چک می‌کنه تا بفهمه کِی باید replenish کنه
router.get('/:deviceId/prekey-count', requireAuth, async (req, res) => {
  const device = await Device.findOne({ user: req.user._id, deviceId: req.params.deviceId }).select('oneTimePrekeys');
  if (!device) return res.status(404).json({ error: 'دستگاه یافت نشد' });
  res.json({ count: device.oneTimePrekeys.length });
});

// لیست سبک (بدون مصرف پیش‌کلید یک‌بارمصرف) - هم برای فهمیدن دستگاه‌های جدید (X3DH) و هم برای
// محاسبه‌ی Safety Number (که فقط identityKeyPub می‌خواد، نه یه Prekey Bundle کامل)
router.get('/list/:userId', requireAuth, async (req, res) => {
  const devices = await Device.find({ user: req.params.userId }).select('deviceId platform identityKeyPub');
  res.json({ devices: devices.map((d) => ({ deviceId: d.deviceId, platform: d.platform, identityKeyPub: d.identityKeyPub })) });
});

// شروع یه گفتگوی جدید (X3DH): همه‌ی دستگاه‌های فعال طرف مقابل رو با یه Prekey Bundle برمی‌گردونه.
// هر OneTimePrekey فقط یه‌بار مصرف می‌شه، پس همون‌جا از لیست حذفش می‌کنیم (atomic با findOneAndUpdate).
// با ?deviceIds=a,b فقط برای همون دستگاه‌ها بسته می‌گیریم (تا برای دستگاه‌هایی که از قبل سشن داریم
// دوباره یه پیش‌کلید یک‌بارمصرف بی‌خودی مصرف نشه)
router.get('/bundle/:userId', requireAuth, async (req, res) => {
  const filter = { user: req.params.userId };
  if (req.query.deviceIds) {
    filter.deviceId = { $in: String(req.query.deviceIds).split(',').filter(Boolean) };
  }
  const devices = await Device.find(filter).select(
    'deviceId platform identityKeyPub identitySignKeyPub signedPrekeyId signedPrekeyPub signedPrekeySig oneTimePrekeys'
  );
  const bundles = await Promise.all(
    devices.map(async (d) => {
      let oneTimePrekey = null;
      if (d.oneTimePrekeys.length) {
        oneTimePrekey = d.oneTimePrekeys[0];
        await Device.updateOne({ _id: d._id }, { $pull: { oneTimePrekeys: { keyId: oneTimePrekey.keyId } } });
      }
      return {
        deviceId: d.deviceId,
        platform: d.platform,
        identityKeyPub: d.identityKeyPub,
        identitySignKeyPub: d.identitySignKeyPub,
        signedPrekeyId: d.signedPrekeyId,
        signedPrekeyPub: d.signedPrekeyPub,
        signedPrekeySig: d.signedPrekeySig,
        oneTimePrekey, // ممکنه null باشه اگه موجودی این دستگاه تموم شده - X3DH بدونش هم انجام‌پذیره (امنیتش کمی کمتره)
      };
    })
  );
  res.json({ devices: bundles });
});

module.exports = router;
