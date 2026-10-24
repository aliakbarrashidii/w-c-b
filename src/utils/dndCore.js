// «مزاحم نشوید» (DND) با زمان‌بندی - منطق خالص و قابل تست؛ همین فایل (کپی عینی) در اپ هم هست تا نمایش وضعیت یکی باشد.
// dnd: { mode: 'off'|'until'|'schedule', until: ms, allowCalls: bool,
//        schedule: { from:'HH:MM', to:'HH:MM', days:[0..6] (0=یکشنبه، روزِ شروعِ بازه), tzOffsetMin: دقیقه‌ی جلوتر از UTC (ایران ۲۱۰) } }
// بازه‌ی شبانه (from > to) متعلق به روزی است که شروع شده: دوشنبه ۲۲:۰۰ تا سه‌شنبه ۰۷:۰۰.
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_UNTIL_MS = 30 * 24 * 3600 * 1000;
const toMin = (s) => { const m = HHMM.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

function isDndActive(dnd, now = Date.now()) {
  if (!dnd || dnd.mode === 'off' || !dnd.mode) return false;
  if (dnd.mode === 'until') return Number(dnd.until) > now;
  if (dnd.mode !== 'schedule') return false;
  const s = dnd.schedule;
  const from = toMin(s?.from); const to = toMin(s?.to);
  if (from === null || to === null || from === to || !Array.isArray(s.days) || !s.days.length) return false;
  const local = new Date(now + (Number(s.tzOffsetMin) || 0) * 60000); // با «ساعت UTC» به‌عنوان ساعتِ محلی کار می‌کنیم
  const day = local.getUTCDay(); const t = local.getUTCHours() * 60 + local.getUTCMinutes();
  const inDay = (d) => s.days.includes(d);
  if (from < to) return inDay(day) && t >= from && t < to;
  return (inDay(day) && t >= from) || (inDay((day + 6) % 7) && t < to); // شبانه
}

// پیام: هر وقت DND فعال باشد بی‌صدا/بدون پوش؛ تماس: فقط اگر allowCalls خاموش باشد
function suppressesPush(dnd, kind = 'message', now = Date.now()) {
  if (!isDndActive(dnd, now)) return false;
  return kind === 'call' ? dnd.allowCalls !== true : true;
}

// ورودی کاربر → مقدار تمیز یا null (نامعتبر). mode=off همیشه معتبر است.
function sanitizeDnd(v, now = Date.now()) {
  if (!v || typeof v !== 'object') return null;
  const allowCalls = v.allowCalls === undefined ? false : v.allowCalls;
  if (typeof allowCalls !== 'boolean') return null;
  if (v.mode === 'off') return { mode: 'off', allowCalls };
  if (v.mode === 'until') {
    const u = Number(v.until);
    if (!Number.isFinite(u) || u <= now || u > now + MAX_UNTIL_MS) return null;
    return { mode: 'until', until: Math.floor(u), allowCalls };
  }
  if (v.mode === 'schedule') {
    const s = v.schedule;
    if (!s || typeof s !== 'object') return null;
    const from = toMin(s.from); const to = toMin(s.to);
    if (from === null || to === null || from === to) return null;
    if (!Array.isArray(s.days) || !s.days.length || s.days.length > 7) return null;
    const days = [...new Set(s.days)];
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return null;
    const tz = Number(s.tzOffsetMin ?? 0);
    if (!Number.isInteger(tz) || tz < -840 || tz > 840) return null;
    return { mode: 'schedule', allowCalls, schedule: { from: s.from, to: s.to, days: days.sort((a, b) => a - b), tzOffsetMin: tz } };
  }
  return null;
}

module.exports = { isDndActive, suppressesPush, sanitizeDnd };
