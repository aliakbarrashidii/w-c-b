// بارگذاریِ ردیف/دسترسی‌های ادمین: req.staff = { tiers, routing, level, tier, can(perm), window }
const { getSettings } = require('../utils/settings');
const { resolveTiers, resolveRouting, levelOf, tierOf, can, contextWindowFor } = require('../utils/staffPolicy');

async function loadStaff(req, res, next) {
  try {
    const level = levelOf(req.user);
    if (level === null) return res.status(403).json({ error: 'دسترسیِ ناظر ندارید', code: 'PERMISSION_DENIED' });
    const settings = await getSettings();
    const tiers = resolveTiers(settings.staffTiers);
    const routing = resolveRouting(settings.moderationRouting);
    req.staff = {
      tiers, routing, level, settings,
      tier: tierOf(req.user, tiers),
      can: (perm) => can(req.user, perm, tiers),
      window: contextWindowFor(req.user, tiers),
    };
    next();
  } catch (err) { next(err); }
}

const requirePerm = (perm) => (req, res, next) => {
  if (!req.staff?.can(perm)) return res.status(403).json({ error: 'این دسترسی برای ردیفِ شما فعال نیست', code: 'PERMISSION_DENIED', permission: perm });
  next();
};

module.exports = { loadStaff, requirePerm };
