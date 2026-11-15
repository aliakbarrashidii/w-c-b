// پیامِ e2eِ چت خصوصی باید برای «همه‌ی دستگاه‌های همه‌ی اعضا (جز دستگاهِ فرستنده)» payload داشته باشد.
// کلاینت فهرستِ دستگاه‌ها را کش می‌کند (تا هر پیام دو درخواستِ شبکه‌ی اضافه نزند)؛ پس سرور مرجع است:
// اگر دستگاهی جا مانده باشد، پیام را نمی‌پذیرد و فهرستِ درست را برمی‌گرداند تا کلاینت دوباره رمز کند.
// (خالص: devices = [{user, deviceId}]، payloads = e2e.payloads، senderDeviceId = e2e.senderDeviceId)
function checkDeviceCoverage(devices, payloads, senderDeviceId) {
  const have = new Set((Array.isArray(payloads) ? payloads : []).map((p) => p?.deviceId).filter(Boolean));
  const missing = devices.filter((d) => d.deviceId !== senderDeviceId && !have.has(d.deviceId));
  if (!missing.length) return { ok: true };
  const map = {};
  for (const d of devices) (map[String(d.user)] = map[String(d.user)] || []).push(d.deviceId);
  return { ok: false, missing: missing.map((d) => d.deviceId), devices: map };
}
module.exports = { checkDeviceCoverage };
