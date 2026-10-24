// جستجوی GIF از طریق Giphy، از سمت سرور (کلید API فقط روی سرور؛ کاربر هیچ کلیدی وارد نمی‌کند) - منطق خالص و قابل تست.
const API = 'https://api.giphy.com/v1/gifs';
const MAX_Q = 50; const MAX_LIMIT = 30; const DEFAULT_LIMIT = 24; const MAX_POS = 500;

function buildGiphyUrl(kind, { q = '', pos = 0, limit = DEFAULT_LIMIT } = {}, key) {
  if (!key) throw new Error('no key');
  const lim = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(limit)) || DEFAULT_LIMIT));
  const off = Math.min(MAX_POS, Math.max(0, Math.floor(Number(pos)) || 0));
  const p = new URLSearchParams({ api_key: key, limit: String(lim), offset: String(off), rating: 'pg-13', bundle: 'messaging_non_clips' });
  if (kind === 'search') {
    const query = String(q).trim().slice(0, MAX_Q);
    if (!query) throw new Error('empty query');
    p.set('q', query);
    return `${API}/search?${p}`;
  }
  return `${API}/trending?${p}`;
}

const isGiphyHost = (h) => h === 'giphy.com' || h.endsWith('.giphy.com');
// فقط HTTPS و فقط دامنه‌ی خودِ Giphy (جلوی لینک جعلی/ردیاب از پاسخ دستکاری‌شده را می‌گیرد)
function isAllowedGifUrl(u) {
  try { const p = new URL(u); return p.protocol === 'https:' && isGiphyHost(p.hostname) && !p.username && !p.password; } catch { return false; }
}

function normalizeGiphy(json) {
  const data = Array.isArray(json?.data) ? json.data : [];
  const items = [];
  for (const g of data) {
    const im = g?.images || {};
    const big = im.downsized_medium?.url ? im.downsized_medium : im.original; // کوچک‌تر و سریع‌تر از original
    const small = im.fixed_width_small?.url ? im.fixed_width_small : im.fixed_width;
    if (!g?.id || !big?.url || !small?.url || !isAllowedGifUrl(big.url) || !isAllowedGifUrl(small.url)) continue;
    items.push({
      id: String(g.id).slice(0, 40),
      title: String(g.title || '').slice(0, 100),
      preview: small.url,
      url: big.url,
      width: Number(big.width) || 0,
      height: Number(big.height) || 0,
      size: Number(big.size) || 0,
    });
  }
  const pg = json?.pagination || {};
  const next = Number(pg.offset) + Number(pg.count);
  const total = Number(pg.total_count);
  return { items, next: Number.isFinite(next) && Number.isFinite(total) && next < total && next <= MAX_POS ? next : null };
}

module.exports = { buildGiphyUrl, normalizeGiphy, isAllowedGifUrl, MAX_Q, MAX_LIMIT, MAX_POS };
