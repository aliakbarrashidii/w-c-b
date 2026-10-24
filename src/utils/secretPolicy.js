// چت مخفی (مثل تلگرام): تایمر خودتخریب از «لحظه‌ی خوانده‌شدن توسط گیرنده» شروع می‌شود و یک‌بار؛ پیام‌های سرویس
// (تغییر تایمر / اسکرین‌شات) ماندگارند. منطق خالص و قابل تست؛ نوشتن در DB در socket/routes است.
const MAX_TTL_SEC = 30 * 86400;
const SCREENSHOT_MIN_GAP_MS = 5000;
const SERVICE_ACTIONS = new Set(['secret_ttl', 'secret_screenshot', 'protected_content']);

// ttl معتبر (عدد صحیح ۰..۳۰ روز) یا null
function parseTtl(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= MAX_TTL_SEC ? n : null;
}

// موعد حذفِ یک پیام وقتی `readerId` آن را خوانده؛ null = تایمر شروع نمی‌شود.
// شروط: چت مخفی، تایمر روشن، پیام سرویس نباشد، خواننده خودِ فرستنده نباشد، قبلاً تایمر نخورده باشد (خواندنِ دوباره حذف را عقب نمی‌اندازد)
function expiryOnRead(chat, message, readerId, now = Date.now()) {
  if (!chat || chat.type !== 'secret') return null;
  const ttl = chat.secretSettings?.ttlSeconds;
  if (!(ttl > 0) || !message) return null;
  if (message.type === 'system_action' || message.expiresAt) return null;
  if (String(message.sender?._id || message.sender) === String(readerId)) return null;
  return new Date(now + ttl * 1000);
}

// محدودیت نرخ اعلان اسکرین‌شات (جلوگیری از اسپم سرویس‌پیام)؛ last = زمان آخرین اعلان همان فرد در همان چت
function screenshotAllowed(last, now = Date.now()) {
  return !(typeof last === 'number' && now - last < SCREENSHOT_MIN_GAP_MS);
}

function serviceMediaMeta(action, params = {}) {
  if (!SERVICE_ACTIONS.has(action)) return null;
  const meta = { action };
  if (action === 'secret_ttl') {
    const t = parseTtl(params.ttlSeconds);
    if (t === null) return null;
    meta.ttlSeconds = t;
  }
  if (action === 'protected_content') {
    if (typeof params.enabled !== 'boolean') return null;
    meta.enabled = params.enabled;
  }
  return meta;
}

// «محدودکردن ذخیره و فوروارد»: فقط مالک و فقط گروه/کانال؛ نتیجه: { ok } یا { ok:false, status, error }
function canSetProtected(chat, memberRole) {
  if (!chat || !['group', 'channel'].includes(chat.type)) return { ok: false, status: 404, error: 'گروه یافت نشد' };
  if (memberRole !== 'owner') return { ok: false, status: 403, error: 'فقط مالک می‌تواند محافظت محتوا را تغییر دهد' };
  return { ok: true };
}
// فورواردِ پیام از این چت مجاز است؟ (چت مخفی همیشه ممنوع؛ چت محافظت‌شده ممنوع)
function forwardBlock(chat) {
  if (!chat) return null;
  if (chat.type === 'secret') return { code: 'E2E_FORWARD', error: 'پیام رمزنگاری‌شده قابل فوروارد نیست' };
  if (chat.protectedContent) return { code: 'PROTECTED', error: 'این چت محافظت‌شده است؛ فوروارد غیرفعال است' };
  return null;
}

module.exports = { canSetProtected, forwardBlock, MAX_TTL_SEC, SCREENSHOT_MIN_GAP_MS, SERVICE_ACTIONS, parseTtl, expiryOnRead, screenshotAllowed, serviceMediaMeta };
