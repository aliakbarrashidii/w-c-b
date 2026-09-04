// شماره‌های ورودی با فرمت‌های مختلف (09123456789 / 9123456789 / +989123456789 / 00989123456789)
// را به یک قالب یکسان +98912xxxxxxx نگاشت می‌کند تا تطبیق مخاطبین قابل‌اعتماد باشد.
function normalizeIranPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  let core;
  if (digits.startsWith('0098')) core = digits.slice(4);
  else if (digits.startsWith('98')) core = digits.slice(2);
  else if (digits.startsWith('0')) core = digits.slice(1);
  else core = digits;

  if (!/^9\d{9}$/.test(core)) return null; // فرمت موبایل ایران معتبر نیست
  return `+98${core}`;
}

module.exports = { normalizeIranPhone };
