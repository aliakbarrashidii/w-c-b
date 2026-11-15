const mongoose = require('mongoose');

// نمونه‌ی برچسب‌دار از تصمیمِ ادمین روی یک گزارشِ هوش مصنوعی — برای کالیبراسیونِ آستانه‌ها و آموزشِ دوباره‌ی مدل.
// ⚠️ حریم خصوصی: فقط «یک پیامِ بررسی‌شده» (نه کل بافت)، بدونِ هیچ شناسه‌ی کاربر/چت. چون خودِ ادمین آن را دیده، اضافه‌شدنش
// به این مجموعه فقط ماندگاری‌اش را زیاد می‌کند؛ با policy.training.enabled خاموش می‌شود و بعد از retentionDays پاک می‌شود.
const schema = new mongoose.Schema(
  {
    caseId: { type: mongoose.Schema.Types.ObjectId, required: true }, // برای یکتایی (یک نمونه به‌ازای هر پرونده)؛ به کاربر/چت وصل نیست
    text: { type: String, required: true, maxlength: 600 },
    label: { type: String, required: true },            // 'normal' (ردشده) یا دسته‌ی تأییدشده
    reportedCategory: { type: String, required: true }, // دسته‌ای که مدل گزارش کرده بود
    confidence: { type: Number, default: null },        // اطمینانِ مدل هنگام گزارش
    lang: { type: String, default: 'fa' },
  },
  { timestamps: true }
);
schema.index({ caseId: 1 }, { unique: true });
schema.index({ lang: 1, createdAt: -1 });
module.exports = mongoose.model('TrainingSample', schema);
