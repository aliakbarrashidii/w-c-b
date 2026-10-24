const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/utils/inlineCore');

test('normalizeResults: پاکسازی، حذف نامعتبر/تکراری، سقف', () => {
  const r = C.normalizeResults([
    { id: 'a', title: ' سلام ', description: 'd', message_text: 'متن' },
    { id: 'a', title: 'تکراری', message_text: 'x' },            // id تکراری
    { id: 'b', title: '', message_text: 'x' },                   // بدون عنوان
    { id: 'c', title: 't', message_text: '   ' },                // متن خالی
    { id: '', title: 't', message_text: 'x' },                   // بدون id
    null, 'str', 5,
    { id: 'd', title: 't', text: 'از فیلد text', thumb_url: 'http://evil/x.png', foo: 1 },
  ]);
  assert.deepEqual(r.map((x) => x.id), ['a', 'd']);
  assert.equal(r[0].title, 'سلام');
  assert.deepEqual(Object.keys(r[1]).sort(), ['description', 'id', 'message_text', 'title']); // thumb_url و ناشناخته‌ها حذف
  assert.equal(r[1].message_text, 'از فیلد text');
  assert.deepEqual(C.normalizeResults('x'), []);
  assert.deepEqual(C.normalizeResults(undefined), []);
});
test('normalizeResults: طول‌ها و سقف ۲۰', () => {
  const big = Array.from({ length: 50 }, (_, i) => ({ id: 'i' + i, title: 't'.repeat(300), description: 'd'.repeat(500), message_text: 'm'.repeat(9000) }));
  const r = C.normalizeResults(big);
  assert.equal(r.length, 20);
  assert.equal(r[0].title.length, 80); assert.equal(r[0].description.length, 120); assert.equal(r[0].message_text.length, 4000);
  assert.equal(C.normalizeResults([{ id: 'x'.repeat(200), title: 't', message_text: 'm' }])[0].id.length, 64);
});
test('commandResults: فیلتر با نام/توضیح و جایگزینی {args}', () => {
  const cmds = [{ command: 'price', description: 'قیمت دلار', reply: 'دلار: {args} ۱۰۰' }, { command: 'help', description: 'راهنما', reply: 'کمک' }, { command: 'empty', description: '', reply: '' }];
  assert.deepEqual(C.commandResults(cmds, '').map((r) => r.id), ['cmd:price', 'cmd:help']);   // بدون پاسخ/توضیح حذف
  assert.deepEqual(C.commandResults(cmds, 'PRI').map((r) => r.id), ['cmd:price']);
  assert.deepEqual(C.commandResults(cmds, 'راهنما').map((r) => r.id), ['cmd:help']);
  assert.equal(C.commandResults(cmds, 'price')[0].message_text, 'دلار:  ۱۰۰');
  assert.deepEqual(C.commandResults(cmds, 'zzz'), []);
  assert.deepEqual(C.commandResults(undefined, 'x'), []);
});
test('parseQuery / parseBotUsername / sanitizePlaceholder', () => {
  assert.equal(C.parseQuery(''), '');
  assert.equal(C.parseQuery('a'.repeat(256)).length, 256);
  assert.equal(C.parseQuery('a'.repeat(257)), null);
  assert.equal(C.parseQuery(5), null);
  assert.equal(C.parseBotUsername('@Weather_Bot'), 'weather_bot');
  for (const bad of ['weather', 'abbot', '1abcbot', 'a bot', '', null, 'x'.repeat(40) + 'bot']) assert.equal(C.parseBotUsername(bad), null, String(bad));
  assert.equal(C.sanitizePlaceholder('  ' + 'x'.repeat(100)).length, 60);
});
test('rateCheck: پنجره‌ی لغزان', () => {
  let st = [];
  for (let i = 0; i < 30; i++) { const r = C.rateCheck(st, 1000 + i); assert.ok(r.ok); st = r.stamps; }
  const blocked = C.rateCheck(st, 1100);
  assert.equal(blocked.ok, false);
  assert.equal(C.rateCheck(st, 1000 + 61_000).ok, true);        // بعد از یک دقیقه آزاد
  assert.equal(C.rateCheck(undefined, 5).ok, true);
});
