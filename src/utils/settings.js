const Settings = require('../models/Settings');

let cache = null;
let cacheAt = 0;
const CACHE_MS = 30 * 1000; // برای اینکه هر رویداد سوکت/هر تیک پاک‌سازی مستقیم به DB نزنه

async function getSettings() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  try {
    cache = await Settings.findOneAndUpdate(
      { key: 'global' },
      {},
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    // دو upsert هم‌زمان (اولین اتصال‌ها روی دیتابیسِ تازه) ← یکی E11000 می‌گیره؛ سند همون لحظه ساخته شده، پس فقط می‌خونیمش
    // (قبلاً این خطا احراز هویتِ سوکت رو می‌کشت: «توکن نامعتبر است» برای اولین کاربرها)
    if (err?.code !== 11000) throw err;
    cache = await Settings.findOne({ key: 'global' });
  }
  cacheAt = Date.now();
  return cache;
}

async function updateSettings(patch) {
  cache = await Settings.findOneAndUpdate(
    { key: 'global' },
    { $set: patch },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  cacheAt = Date.now();
  return cache;
}

module.exports = { getSettings, updateSettings };
