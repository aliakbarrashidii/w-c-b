// کمک‌ها برای ارسال فایل توسط ربات (sendPhoto/sendDocument/sendVoice): بررسی امضای واقعی تصویر و سقف تعداد آپلود.

// امضای (magic bytes) تصویرهای مجاز - به Content-Type/پسوندی که ربات ادعا می‌کنه اعتماد نمی‌کنیم
function looksLikeImage(buf) {
  if (!buf || buf.length < 12) return false;
  const hex = buf.subarray(0, 12).toString('hex');
  if (hex.startsWith('ffd8ff')) return true; // JPEG
  if (hex.startsWith('89504e470d0a1a0a')) return true; // PNG
  if (hex.startsWith('474946383761') || hex.startsWith('474946383961')) return true; // GIF87a/89a
  if (hex.startsWith('52494646') && buf.subarray(8, 12).toString('ascii') === 'WEBP') return true; // WEBP
  return false;
}

// حداکثر آپلود در ساعت برای هر ربات (جلوگیری از پر کردن دیسک)
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 60;
const hits = new Map();
function allowBotUpload(botId, now = Date.now()) {
  const key = String(botId);
  const arr = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) { hits.set(key, arr); return false; }
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 1000) for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  return true;
}

module.exports = { looksLikeImage, allowBotUpload, MAX_PER_WINDOW };
