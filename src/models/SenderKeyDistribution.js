const mongoose = require('mongoose');

// سرور محتوای واقعیِ سندرکی رو نمی‌بینه (e2e طبق همون مکانیزم ۱به۱ رمزشده) - فقط تا رسیدنِ گیرنده نگهش می‌داره
const senderKeyDistributionSchema = new mongoose.Schema(
  {
    toUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fromUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true },
    e2e: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SenderKeyDistribution', senderKeyDistributionSchema);
