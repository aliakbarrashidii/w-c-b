const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/utils/secretPolicy');

const chat = (ttl, type = 'secret') => ({ type, secretSettings: { ttlSeconds: ttl } });
const msg = (over = {}) => ({ type: 'text', sender: 'a', expiresAt: null, ...over });

test('parseTtl: بازه و نوع', () => {
  assert.equal(P.parseTtl(0), 0);
  assert.equal(P.parseTtl(3600), 3600);
  assert.equal(P.parseTtl('60'), 60);
  assert.equal(P.parseTtl(P.MAX_TTL_SEC), P.MAX_TTL_SEC);
  for (const bad of [-1, P.MAX_TTL_SEC + 1, 1.5, 'x', '', '-5', null, undefined, NaN, {}, []]) assert.equal(P.parseTtl(bad), null, String(bad));
});
test('expiryOnRead: فقط خواندنِ گیرنده، یک‌بار', () => {
  const now = 1_000_000;
  assert.equal(P.expiryOnRead(chat(60), msg(), 'b', now).getTime(), now + 60_000);
  assert.equal(P.expiryOnRead(chat(60), msg({ sender: 'b' }), 'b', now), null);            // فرستنده خودش خواند
  assert.equal(P.expiryOnRead(chat(60), msg({ sender: { _id: 'b' } }), 'b', now), null);   // sender پاپیولیت‌شده
  assert.equal(P.expiryOnRead(chat(60), msg({ expiresAt: new Date(5) }), 'b', now), null); // خواندنِ دوباره حذف را عقب نمی‌اندازد
  assert.equal(P.expiryOnRead(chat(0), msg(), 'b', now), null);                            // تایمر خاموش
  assert.equal(P.expiryOnRead(chat(60, 'private'), msg(), 'b', now), null);                // فقط چت مخفی
  assert.equal(P.expiryOnRead(chat(60), msg({ type: 'system_action' }), 'b', now), null);  // سرویس‌پیام ماندگار
  assert.equal(P.expiryOnRead(null, msg(), 'b', now), null);
  assert.equal(P.expiryOnRead(chat(60), null, 'b', now), null);
});
test('screenshotAllowed: فاصله‌ی حداقل', () => {
  assert.equal(P.screenshotAllowed(undefined, 10_000), true);
  assert.equal(P.screenshotAllowed(10_000, 12_000), false);
  assert.equal(P.screenshotAllowed(10_000, 15_000), true);
});
test('serviceMediaMeta', () => {
  assert.deepEqual(P.serviceMediaMeta('secret_ttl', { ttlSeconds: 60 }), { action: 'secret_ttl', ttlSeconds: 60 });
  assert.deepEqual(P.serviceMediaMeta('secret_ttl', { ttlSeconds: 0 }), { action: 'secret_ttl', ttlSeconds: 0 });
  assert.equal(P.serviceMediaMeta('secret_ttl', { ttlSeconds: -1 }), null);
  assert.equal(P.serviceMediaMeta('secret_ttl', {}), null);
  assert.deepEqual(P.serviceMediaMeta('secret_screenshot'), { action: 'secret_screenshot' });
  assert.equal(P.serviceMediaMeta('open_url'), null);                                       // اکشن‌های دیگرِ سیستمی از این مسیر ساخته نمی‌شوند
});

test('serviceMediaMeta: protected_content فقط با enabled بولین', () => {
  assert.deepEqual(P.serviceMediaMeta('protected_content', { enabled: true }), { action: 'protected_content', enabled: true });
  assert.deepEqual(P.serviceMediaMeta('protected_content', { enabled: false }), { action: 'protected_content', enabled: false });
  for (const bad of [{}, { enabled: 'true' }, { enabled: 1 }, { enabled: null }]) assert.equal(P.serviceMediaMeta('protected_content', bad), null);
});
test('canSetProtected: فقط مالکِ گروه/کانال', () => {
  assert.deepEqual(P.canSetProtected({ type: 'group' }, 'owner'), { ok: true });
  assert.deepEqual(P.canSetProtected({ type: 'channel' }, 'owner'), { ok: true });
  assert.equal(P.canSetProtected({ type: 'group' }, 'admin').status, 403);
  assert.equal(P.canSetProtected({ type: 'group' }, 'member').status, 403);
  assert.equal(P.canSetProtected({ type: 'private' }, 'owner').status, 404);
  assert.equal(P.canSetProtected({ type: 'secret' }, 'owner').status, 404);
  assert.equal(P.canSetProtected(null, 'owner').status, 404);
});
test('forwardBlock: مخفی و محافظت‌شده ممنوع، عادی آزاد', () => {
  assert.equal(P.forwardBlock({ type: 'group', protectedContent: true }).code, 'PROTECTED');
  assert.equal(P.forwardBlock({ type: 'secret' }).code, 'E2E_FORWARD');
  assert.equal(P.forwardBlock({ type: 'secret', protectedContent: true }).code, 'E2E_FORWARD');   // مخفی اولویت دارد
  assert.equal(P.forwardBlock({ type: 'group', protectedContent: false }), null);
  assert.equal(P.forwardBlock({ type: 'private' }), null);
  assert.equal(P.forwardBlock(null), null);
});
