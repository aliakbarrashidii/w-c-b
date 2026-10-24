// سیاست نشست‌ها (الهام‌گرفته از تلگرام): ورود از یک دستگاه ناشناسِ تازه تا ۲۴ ساعت «محدود» است — نمی‌تواند نشست‌های دیگر را ببندد،
// رمز را عوض کند، ورود دومرحله‌ای را خاموش کند یا حساب را حذف کند، مگر اینکه صاحب حساب از یک دستگاه قدیمیِ معتبر تأییدش کند.
// هدف: اگر کسی رمز را دزدیده باشد، با یک ورودِ تازه نتواند فوراً صاحب اصلی را بیرون بیندازد.
const RESTRICT_MS = 24 * 60 * 60 * 1000;

function sanitizeDeviceInfo(body = {}) {
  const d = body.device && typeof body.device === 'object' ? body.device : {};
  const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  return {
    deviceId: clip(d.id, 80),
    deviceName: clip(d.name, 80) || clip(body.deviceName, 80), // body.deviceName: کلاینت‌های قدیمی
    platform: ['android', 'ios', 'web'].includes(d.platform) ? d.platform : '',
    osVersion: clip(d.osVersion, 40),
    appVersion: clip(d.appVersion, 40),
  };
}

// نشست «محدود» است اگر مهلتش نگذشته و هنوز تأیید نشده باشد
function isRestricted(session, now = Date.now()) {
  if (!session || !session.restrictedUntil || session.confirmedAt) return false;
  return new Date(session.restrictedUntil).getTime() > now;
}

// اولین نشستِ حساب، یا دستگاهی که قبلاً معتبر بوده (همان deviceId)، محدود نمی‌شود.
function computeRestrictedUntil({ hadPriorSession, knownDevice, now = Date.now() }) {
  if (!hadPriorSession || knownDevice) return null;
  return new Date(now + RESTRICT_MS);
}

// فقط یک نشست معتبر (نه محدود) و غیر از خودِ هدف می‌تواند نشستِ محدودِ هدف را تأیید کند
function canConfirm(callerSession, targetSession, now = Date.now()) {
  if (!callerSession || !targetSession) return false;
  if (String(callerSession._id) === String(targetSession._id)) return false;
  if (callerSession.revoked || isRestricted(callerSession, now)) return false;
  return isRestricted(targetSession, now);
}

module.exports = { RESTRICT_MS, sanitizeDeviceInfo, isRestricted, computeRestrictedUntil, canConfirm };
