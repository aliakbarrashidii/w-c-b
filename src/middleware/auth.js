const { verifyAccessToken, isTokenCurrent } = require('../utils/tokens');
const User = require('../models/User');
const Session = require('../models/Session');

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'توکن ارسال نشده است' });

    const payload = verifyAccessToken(token);
    const user = await User.findById(payload.id);
    if (!user) return res.status(401).json({ error: 'کاربر یافت نشد' });
    if (user.status === 'deleted') return res.status(401).json({ error: 'این حساب حذف شده است' });
    if (user.status === 'banned') return res.status(403).json({ error: 'حساب شما مسدود شده است' });
    if (user.status === 'suspended' && user.suspendedUntil && user.suspendedUntil > new Date()) {
      return res.status(403).json({ error: 'حساب شما موقتاً معلق شده است', until: user.suspendedUntil });
    }

    // نشست باید هنوز فعال (revoke نشده) باشد — امکان خروج از راه دور یک دستگاه خاص
    if (!isTokenCurrent(payload, user)) return res.status(401).json({ error: 'توکن ابطال شده است' });
    if (payload.sid) {
      const session = await Session.findById(payload.sid);
      if (!session || session.revoked) {
        return res.status(401).json({ error: 'این نشست منقضی یا از راه دور خارج شده است' });
      }
      session.lastActiveAt = new Date();
      session.save().catch(() => {});
      req.sessionId = session._id;
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'توکن نامعتبر است' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'دسترسی غیرمجاز' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
