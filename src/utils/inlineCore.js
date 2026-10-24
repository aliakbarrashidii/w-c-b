// ربات inline (مثل تلگرام): کاربر در نوار ورودی `@my_bot متن` می‌نویسد، ربات فهرست نتیجه می‌دهد، کاربر یکی را می‌فرستد
// (پیام با برچسب «via @my_bot»). منطق خالص و قابل تست؛ ارتباط با DB/سوکت در botEngine و routes/bots است.
const MAX_RESULTS = 20;
const MAX_QUERY = 256;
const RATE_PER_MIN = 30;
const TITLE_MAX = 80; const DESC_MAX = 120; const TEXT_MAX = 4000; const ID_MAX = 64;

// نتایج خام ربات (غیرقابل‌اعتماد) → فهرست تمیز. فقط «مقاله» (متن)؛ بدون thumb_url/تصویر بیرونی (ردیابی IP کاربران).
function normalizeResults(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    if (out.length >= MAX_RESULTS) break;
    if (!r || typeof r !== 'object') continue;
    const id = String(r.id ?? '').slice(0, ID_MAX);
    const title = String(r.title ?? '').trim().slice(0, TITLE_MAX);
    const text = String(r.message_text ?? r.text ?? '').slice(0, TEXT_MAX);
    if (!id || seen.has(id) || !title || !text.trim()) continue;
    seen.add(id);
    out.push({ id, title, description: String(r.description ?? '').trim().slice(0, DESC_MAX), message_text: text });
  }
  return out;
}

// ربات بدون‌کد: دستورهایی که نام/توضیحشان با query جور است (query خالی = همه)؛ پاسخ دستور همان متنی است که فرستاده می‌شود
function commandResults(commands, query) {
  const q = String(query || '').trim().toLowerCase();
  const rows = (Array.isArray(commands) ? commands : []).filter((c) => c && c.command && (c.reply || c.description));
  const hit = q ? rows.filter((c) => c.command.toLowerCase().includes(q) || String(c.description || '').toLowerCase().includes(q)) : rows;
  return normalizeResults(hit.map((c) => ({ id: `cmd:${c.command}`, title: `/${c.command}`, description: c.description || '', message_text: String(c.reply || c.description || '').replace(/\{args\}/g, '') })));
}

function parseQuery(q) {
  if (typeof q !== 'string') return null;
  return q.length <= MAX_QUERY ? q : null;
}

// محدودیت نرخ لغزان: stamps = زمان‌های قبلی (ms). خروجی { ok, stamps }
function rateCheck(stamps, now = Date.now(), limit = RATE_PER_MIN, windowMs = 60000) {
  const recent = (stamps || []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) return { ok: false, stamps: recent };
  return { ok: true, stamps: [...recent, now] };
}

const BOT_USERNAME = /^[a-z][a-z0-9_]{2,28}bot$/;
function parseBotUsername(u) {
  const s = String(u || '').trim().toLowerCase().replace(/^@/, '');
  return BOT_USERNAME.test(s) ? s : null;
}

function sanitizePlaceholder(p) { return String(p || '').trim().slice(0, 60); }

module.exports = { MAX_RESULTS, MAX_QUERY, RATE_PER_MIN, normalizeResults, commandResults, parseQuery, rateCheck, parseBotUsername, sanitizePlaceholder };
