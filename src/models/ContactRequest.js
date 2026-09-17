const mongoose = require('mongoose');

const contactRequestSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, default: '' },
    message: { type: String, default: '' },
    resolved: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ContactRequest', contactRequestSchema);
