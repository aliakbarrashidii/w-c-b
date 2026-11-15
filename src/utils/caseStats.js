const mongoose = require('mongoose');
const Report = require('../models/Report');
const EncryptedReport = require('../models/EncryptedReport');

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const STATUSES = ['pending', 'under_review', 'confirmed', 'dismissed'];

// آمارِ پرونده‌های علیهِ یک کاربر: { ai|user: { pending, under_review, confirmed, dismissed, total }, confirmedByCategory:{cat:n} }
async function userCaseStats(userId) {
  const id = oid(userId);
  const [u, a] = await Promise.all([
    Report.aggregate([{ $match: { targetUser: id } }, { $group: { _id: { s: '$status', c: '$category' }, n: { $sum: 1 } } }]),
    EncryptedReport.aggregate([{ $match: { accusedUser: id } }, { $group: { _id: { s: '$status', c: '$category' }, n: { $sum: 1 } } }]),
  ]);
  const fold = (rows) => {
    const out = { total: 0, byCategory: {} };
    for (const s of STATUSES) out[s] = 0;
    for (const r of rows) {
      out[r._id.s] = (out[r._id.s] || 0) + r.n; out.total += r.n;
      const c = r._id.c || 'unknown';
      out.byCategory[c] = out.byCategory[c] || { total: 0, confirmed: 0, dismissed: 0, pending: 0, under_review: 0 };
      out.byCategory[c].total += r.n; out.byCategory[c][r._id.s] += r.n;
    }
    return out;
  };
  const ai = fold(a); const user = fold(u);
  const confirmedByCategory = {};
  for (const src of [ai, user]) for (const [c, v] of Object.entries(src.byCategory)) confirmedByCategory[c] = (confirmedByCategory[c] || 0) + v.confirmed;
  return { ai, user, confirmedByCategory, confirmedTotal: ai.confirmed + user.confirmed };
}

async function confirmedCount(userId, category) {
  const id = oid(userId);
  const f = category ? { category } : {};
  const [u, a] = await Promise.all([
    Report.countDocuments({ targetUser: id, status: 'confirmed', ...f }),
    EncryptedReport.countDocuments({ accusedUser: id, status: 'confirmed', ...f }),
  ]);
  return u + a;
}

async function reportCountSince(userId, since) {
  const id = oid(userId);
  const [u, a] = await Promise.all([
    Report.countDocuments({ targetUser: id, createdAt: { $gte: since } }),
    EncryptedReport.countDocuments({ accusedUser: id, createdAt: { $gte: since } }),
  ]);
  return u + a;
}

module.exports = { userCaseStats, confirmedCount, reportCountSince };
