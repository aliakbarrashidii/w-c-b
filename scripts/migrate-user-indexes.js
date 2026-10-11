// اجرا (یک‌بار، روی دیتابیس موجود):  MONGODB_URI=... node scripts/migrate-user-indexes.js (همون متغیر .env سرور؛ یا از .env خونده می‌شه)
// مشکل: phoneHash/telegramId با default:null ذخیره می‌شدن و ایندکس unique+sparse مقدار null رو هم می‌پذیره و فقط یک‌بار اجازه می‌ده
// → دومین کاربرِ بدون تلفن (ربات، حساب ساخته‌شده توسط مدیر، حساب سیستم) با خطای E11000 ساخته نمی‌شد.
// این اسکریپت: ۱) فیلدهای null رو unset می‌کنه ۲) ایندکس‌های قدیمی رو حذف می‌کنه ۳) ایندکس‌های partial جدید رو می‌سازه.
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI تنظیم نشده'); process.exit(1); }
  await mongoose.connect(uri);
  const users = mongoose.connection.collection('users');
  for (const field of ['phoneHash', 'telegramId']) {
    const r = await users.updateMany({ [field]: null }, { $unset: { [field]: '' } });
    console.log(`${field}: ${r.modifiedCount} مقدار null حذف شد`);
    try { await users.dropIndex(`${field}_1`); console.log(`ایندکس قدیمی ${field}_1 حذف شد`); } catch (e) { console.log(`ایندکس ${field}_1: ${e.codeName || e.message}`); }
    await users.createIndex({ [field]: 1 }, { unique: true, partialFilterExpression: { [field]: { $type: 'string' } } });
    console.log(`ایندکس partial ${field} ساخته شد`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
