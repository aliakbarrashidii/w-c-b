// تست بدون DB: لایه‌ی HTTP ضد-SSRF برای webhook/LLM ربات‌ها
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { safePost, isPublicIp } = require('../src/utils/safeHttp');

test('isPublicIp: خصوصی/لوپ‌بک/لینک‌لوکال/متادیتا مسدود، عمومی مجاز', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'ff02::1', '64:ff9b::7f00:1', 'not-an-ip']) {
    assert.equal(isPublicIp(ip), false, `باید مسدود باشه: ${ip}`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111']) {
    assert.equal(isPublicIp(ip), true, `باید مجاز باشه: ${ip}`);
  }
});

test('safePost: آی‌پی خصوصی مستقیم، و localhost (از مسیر DNS) هر دو رد می‌شن؛ سرور داخلی هیچ درخواستی نمی‌گیره', async () => {
  let hits = 0;
  const srv = await new Promise((resolve) => { const s = http.createServer((q, r) => { hits++; r.end('secret'); }); s.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const port = srv.address().port;
    await assert.rejects(() => safePost(`http://127.0.0.1:${port}/x`, {}), /SSRF/);
    await assert.rejects(() => safePost(`http://localhost:${port}/x`, {}), /SSRF/);
    await assert.rejects(() => safePost(`http://[::1]:${port}/x`, {}), /SSRF/);
    await assert.rejects(() => safePost(`http://169.254.169.254/latest/meta-data/`, {}), /SSRF/);
    assert.equal(hits, 0, 'هیچ درخواستی نباید به سرور داخلی برسه');
  } finally { srv.close(); }
});

test('safePost: ترافیک عمومی عادی با ساختار lookup خراب نشده (خطای SSRF نمی‌گیره)', async (t) => {
  try {
    const res = await safePost('https://api.github.com/', {}, { validateStatus: () => true, timeout: 8000 });
    assert.ok(res.status >= 200);
  } catch (e) {
    if (/SSRF/.test(e.message)) assert.fail('ترافیک عمومی نباید SSRF حساب بشه');
    t.skip(`شبکه در دسترس نیست: ${e.code || e.message}`); // آفلاین/محدودیت شبکه
  }
});
