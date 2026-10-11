const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const axios = require('axios');

// درخواست خروجیِ امن به URLهایی که کاربر می‌ده (webhook ربات، آدرس LLM). isSafeUrl فقط «ظاهرِ نامِ میزبان» رو می‌بینه؛ کافیه
// دامنه‌ای به 127.0.0.1 / 10.x / 169.254.169.254 (متادیتای ابر) resolve بشه، یا یه URL عمومی ریدایرکت کنه، یا DNS-rebinding بشه
// تا سرور به سرویس‌های داخلی (SSRF) وصل بشه. اینجا: (۱) آدرسِ resolve‌شده «موقع اتصال» چک می‌شه (بدون TOCTOU)، (۲) ریدایرکت
// ممنوع، (۳) سقف اندازه‌ی پاسخ و زمان.
const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv6'));

// ⚠️ net.BlockList آدرس‌های IPv4 رو به‌صورت mapped (::ffff:a.b.c.d) با قانون‌های IPv6 هم مقایسه می‌کنه؛ پس بلاک کردن ::ffff:0:0/96
// «همه‌ی IPv4 عمومی» رو هم مسدود می‌کرد (تست گرفتش). آدرس‌های mapped رو اینجا صریحاً به IPv4 برمی‌گردونیم و همون‌جا چک می‌کنیم.
function unmapIPv4(ip) {
  const dotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dotted) return dotted[1];
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) { const hi = parseInt(hex[1], 16); const lo = parseInt(hex[2], 16); return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`; }
  return null;
}

function isPublicIp(ip) {
  const family = net.isIP(ip);
  if (!family) return false;
  if (family === 6) { const v4 = unmapIPv4(ip); if (v4) return isPublicIp(v4); }
  return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => !isPublicIp(a.address))) return cb(new Error('SSRF: آدرس مقصد عمومی نیست'));
    if (options?.all) return cb(null, addrs);
    return cb(null, addrs[0].address, addrs[0].family);
  });
}

const httpAgent = new http.Agent({ lookup: guardedLookup });
const httpsAgent = new https.Agent({ lookup: guardedLookup });

async function safePost(url, data, config = {}) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  // آی‌پیِ مستقیم تو URL از lookup رد نمی‌شه؛ همین‌جا چک می‌کنیم
  if (net.isIP(host) && !isPublicIp(host)) throw new Error('SSRF: آدرس مقصد عمومی نیست');
  return axios.post(url, data, {
    timeout: 8000,
    ...config,
    httpAgent,
    httpsAgent,
    maxRedirects: 0, // ریدایرکت = دور زدن چک‌ها
    maxContentLength: 1024 * 1024,
    maxBodyLength: 1024 * 1024,
  });
}

module.exports = { safePost, isPublicIp };
