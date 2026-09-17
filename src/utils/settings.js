const Settings = require('../models/Settings');

let cache = null;
let cacheAt = 0;
const CACHE_MS = 30 * 1000; // برای اینکه هر رویداد سوکت/هر تیک پاک‌سازی مستقیم به DB نزنه

async function getSettings() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  cache = await Settings.findOneAndUpdate(
    { key: 'global' },
    {},
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
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
