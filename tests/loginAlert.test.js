const test = require('node:test');
const assert = require('node:assert/strict');
const { pickTokens, newLoginPushPayload } = require('../src/utils/loginAlert');

test('pickTokens: یکتا و فقط رشته‌ی معتبر', () => {
  assert.deepEqual(pickTokens({ pushTokens: ['a', 'a', ' ', '', null, 5, 'b'] }), ['a', 'b']);
  assert.deepEqual(pickTokens({}), []);
  assert.deepEqual(pickTokens(null), []);
});
test('newLoginPushPayload: شناسه‌ها رشته، نام دستگاه تمیز و کوتاه', () => {
  const p = newLoginPushPayload({ session: { deviceName: '  Galaxy   S24 ' }, chatId: { toString: () => 'c1' }, messageId: 'm1', userId: 'u1' });
  assert.equal(p.title, 'ورود جدید به حساب');
  assert.ok(p.body.startsWith('Galaxy S24 —'));
  assert.deepEqual(p.data, { type: 'message', kind: 'new_login', chatId: 'c1', messageId: 'm1', recipientId: 'u1' });
  assert.ok(newLoginPushPayload({ session: {}, chatId: 'c', messageId: 'm', userId: 'u' }).body.startsWith('دستگاه ناشناس'));
  assert.ok(newLoginPushPayload({ session: { deviceName: 'x'.repeat(200) }, chatId: 'c', messageId: 'm', userId: 'u' }).body.indexOf(' —') <= 40);
});
