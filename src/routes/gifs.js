const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const { buildGiphyUrl, normalizeGiphy } = require('../utils/gifCore');

// جستجوی GIF (Giphy): کلید فقط روی سرور (GIPHY_API_KEY). بدون کلید، /status می‌گوید غیرفعال و اپ تب GIF را نشان نمی‌دهد.
function defaultFetchJson(url) {
  return axios.get(url, { timeout: 6000, maxContentLength: 2 * 1024 * 1024, validateStatus: (s) => s === 200 }).then((r) => r.data);
}

function createGifRouter({ fetchJson = defaultFetchJson, getKey = () => process.env.GIPHY_API_KEY, now = () => Date.now() } = {}) {
  const router = express.Router();
  const cache = new Map(); // درخواست تکراری (مثل «trending») تا ۶۰ ثانیه از حافظه
  const TTL = 60_000; const MAX_CACHE = 200;
  const limiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => String(req.user?._id || req.ip), message: { error: 'درخواست‌های زیاد؛ کمی بعد دوباره امتحان کن', code: 'RATE_LIMITED' } });

  router.get('/status', requireAuth, (req, res) => res.json({ enabled: !!getKey() }));

  async function handle(kind, req, res) {
    const key = getKey();
    if (!key) return res.status(501).json({ error: 'جستجوی GIF روی این سرور فعال نیست', code: 'GIF_NOT_CONFIGURED' });
    let url;
    try { url = buildGiphyUrl(kind, { q: req.query.q, pos: req.query.pos }, key); } catch { return res.status(400).json({ error: 'عبارت جستجو نامعتبر است' }); }
    const ck = `${kind}|${String(req.query.q || '').trim().toLowerCase()}|${Number(req.query.pos) || 0}`;
    const hit = cache.get(ck);
    if (hit && now() - hit.at < TTL) return res.json(hit.value);
    try {
      const value = normalizeGiphy(await fetchJson(url));
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(ck, { at: now(), value });
      res.json(value);
    } catch {
      res.status(502).json({ error: 'سرویس GIF پاسخ نداد', code: 'GIF_UPSTREAM' });
    }
  }
  router.get('/search', requireAuth, limiter, (req, res) => handle('search', req, res));
  router.get('/trending', requireAuth, limiter, (req, res) => handle('trending', req, res));
  return router;
}

module.exports = { createGifRouter };
