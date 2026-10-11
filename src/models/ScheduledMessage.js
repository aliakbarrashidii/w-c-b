const mongoose = require('mongoose');

// پیام زمان‌دار - محتوا (چه رمزشده با E2E چه نه) از همون لحظه‌ی ارسال کامل و ثابته؛ فقط تحویلش
// عقب می‌افته. زمان رسیدنش رو خودِ سرور (نه گوشیِ فرستنده) تشخیص می‌ده، پس اختلاف ساعت گوشی با
// سرور روی این‌که "کِی واقعاً می‌رسه" اثر نداره - فقط گوشی موقع انتخاب تایم باید ساعت سرور رو
// در نظر بگیره (mobile-app/src/utils/serverTime.js) تا چیزی که کاربر انتخاب کرده درست باشه.
const scheduledMessageSchema = new mongoose.Schema(
  {
    chat: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true, index: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    clientId: { type: String, default: null },
    type: { type: String, default: 'text' },
    content: { type: String, default: '' },
    e2e: { type: mongoose.Schema.Types.Mixed, default: null },
    groupE2e: { type: mongoose.Schema.Types.Mixed, default: null },
    mediaUrl: { type: String, default: '' },
    mediaMeta: { type: mongoose.Schema.Types.Mixed, default: {} },
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
    scheduledFor: { type: Date, required: true, index: true },
    status: { type: String, enum: ['pending', 'sent', 'cancelled', 'failed'], default: 'pending' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ScheduledMessage', scheduledMessageSchema);
