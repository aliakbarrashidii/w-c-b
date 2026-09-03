const mongoose = require('mongoose');

const callLogSchema = new mongoose.Schema(
  {
    chat: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true },
    caller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    callee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['voice', 'video'], required: true },
    status: { type: String, enum: ['ringing', 'accepted', 'missed', 'declined', 'ended'], default: 'ringing' },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
    durationSec: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CallLog', callLogSchema);
