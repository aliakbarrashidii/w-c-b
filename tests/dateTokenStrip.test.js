const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { stripDateTokens } = require('../src/utils/dateTokenStrip');
const appFile = path.join(__dirname, '..', '..', 'mobile-app', 'src', 'utils', 'dateToken.js');

test('stripDateTokens: فقط توکن معتبر', () => {
  assert.equal(stripDateTokens('جلسه {t:1761000000:f} و {t:5:r}!'), 'جلسه 📅 و 📅!');
  assert.equal(stripDateTokens('{t:x:f} {t:1:z} {t:1:f'), '{t:x:f} {t:1:z} {t:1:f');
  assert.equal(stripDateTokens(undefined), '');
  assert.equal(stripDateTokens('بدون توکن'), 'بدون توکن');
});
test('همگام با نسخه‌ی اپ (همان الگو)', { skip: !fs.existsSync(appFile) && 'پوشه‌ی mobile-app کنار backend نیست' }, async () => {
  const app = await import(appFile);
  const sample = 'a {t:1761000000:D} b {t:7:t} c {bad}';
  assert.equal(stripDateTokens(sample), app.stripDateTokens(sample));
});
