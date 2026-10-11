// Express 4 خطای هندلرهای async رو نمی‌گیره: یه throw تو `async (req,res) => {...}` (مثلاً CastError برای ObjectIdِ نامعتبر مثل
// GET /api/chats/abc) تبدیل به unhandled rejection می‌شه و در Node ≥ 15 «کل پروسه‌ی سرور» رو می‌کشه (قطع سرویس با یک درخواست).
// این شیم، rejection هر هندلر/میدل‌ویر رو به next(err) می‌فرسته تا میدل‌ویر خطای server.js جوابِ ۴۰۰/۵۰۰ بده. (معادل express-async-errors)
const Layer = require('express/lib/router/layer');

const original = Layer.prototype.handle_request;
Layer.prototype.handle_request = function handleRequestWithAsync(req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) return next(); // میدل‌ویر خطا؛ اینجا اجرا نمی‌شه
  try {
    const result = fn(req, res, next);
    if (result && typeof result.catch === 'function') result.catch(next);
  } catch (err) {
    next(err);
  }
};
Layer.prototype.handle_request.__original = original;

// شبکه‌ی اطمینانِ آخر (هندلرهای socket.io async هم تحت پوشش express نیستن): فقط لاگ؛ سرور نمی‌میره.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack || reason.message : reason);
});
