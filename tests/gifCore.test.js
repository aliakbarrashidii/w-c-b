const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/utils/gifCore');
const Q = require('../src/utils/replyQuote');
const A = require('../src/utils/groupAddPolicy');

const sample = (over = {}) => ({ id: 'abc', title: 'Cat', images: { downsized_medium: { url: 'https://media2.giphy.com/m/a.gif', width: '200', height: '150', size: '120000' }, original: { url: 'https://media2.giphy.com/m/o.gif', width: '400', height: '300', size: '900000' }, fixed_width_small: { url: 'https://media2.giphy.com/m/s.gif' } }, ...over });

test('buildGiphyUrl: clamps limit/offset, trims & caps query, rating pg-13, needs key and a query for search', () => {
  const u = new URL(G.buildGiphyUrl('search', { q: '  cat  ', pos: 9999, limit: 999 }, 'K'));
  assert.equal(u.searchParams.get('q'), 'cat'); assert.equal(u.searchParams.get('limit'), '30'); assert.equal(u.searchParams.get('offset'), '500'); assert.equal(u.searchParams.get('rating'), 'pg-13');
  assert.equal(new URL(G.buildGiphyUrl('search', { q: 'x'.repeat(200) }, 'K')).searchParams.get('q').length, 50);
  assert.ok(G.buildGiphyUrl('trending', {}, 'K').includes('/trending?'));
  assert.throws(() => G.buildGiphyUrl('search', { q: '   ' }, 'K')); assert.throws(() => G.buildGiphyUrl('trending', {}, ''));
  assert.equal(new URL(G.buildGiphyUrl('trending', { limit: -5, pos: -3 }, 'K')).searchParams.get('offset'), '0');
});
test('normalizeGiphy: picks the smaller rendition, keeps only giphy https hosts, survives garbage', () => {
  const r = G.normalizeGiphy({ data: [sample(), sample({ id: 'evil', images: { original: { url: 'https://evil.com/x.gif' }, fixed_width: { url: 'https://media.giphy.com/s.gif' } } }), sample({ id: 'http', images: { original: { url: 'http://media.giphy.com/x.gif' }, fixed_width: { url: 'https://media.giphy.com/s.gif' } } }), { id: 'noimg' }, null], pagination: { offset: 0, count: 5, total_count: 50 } });
  assert.deepEqual(r.items.map((i) => i.id), ['abc']);
  assert.equal(r.items[0].url, 'https://media2.giphy.com/m/a.gif'); assert.equal(r.items[0].width, 200);
  assert.equal(r.next, 5);
  assert.deepEqual(G.normalizeGiphy(null), { items: [], next: null }); assert.deepEqual(G.normalizeGiphy({ data: 'x' }), { items: [], next: null });
  assert.equal(G.normalizeGiphy({ data: [], pagination: { offset: 45, count: 5, total_count: 50 } }).next, null); // آخر لیست
});
test('isAllowedGifUrl: https + giphy.com family only, no credentials, no lookalikes', () => {
  assert.equal(G.isAllowedGifUrl('https://media0.giphy.com/a.gif'), true);
  for (const bad of ['http://media.giphy.com/a.gif', 'https://giphy.com.evil.com/a.gif', 'https://evilgiphy.com/a.gif', 'https://u:p@media.giphy.com/a.gif', 'javascript:alert(1)', 'not a url', '']) assert.equal(G.isAllowedGifUrl(bad), false, bad);
});
test('sanitizeReplyQuote: integer range inside the max message length only', () => {
  assert.deepEqual(Q.sanitizeReplyQuote({ start: 3, end: 10 }), { start: 3, end: 10 });
  assert.deepEqual(Q.sanitizeReplyQuote({ start: 0, end: 4000 }), { start: 0, end: 4000 }); // مرز بالا
  for (const bad of [null, undefined, 'x', {}, { start: 5, end: 5 }, { start: 6, end: 5 }, { start: -1, end: 5 }, { start: 0, end: 4001 }, { start: 1.5, end: 3 }, { start: '1', end: '3' }]) {
    assert.equal(Q.sanitizeReplyQuote(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(Q.sanitizeReplyQuote({ start: 1, end: 9, text: 'LEAK' }), { start: 1, end: 9 }); // فیلد اضافه (مثل متن) دور ریخته می‌شود
});
test('canAddToGroup / partitionAddable: everyone, contacts (target saved the adder), nobody; bots exempt', () => {
  const adder = 'u1';
  const mk = (id, groupAdd, saved = [], isBot = false) => ({ _id: id, isBot, privacy: { groupAdd }, savedContacts: saved.map((c) => ({ contact: c })) });
  assert.equal(A.canAddToGroup(mk('a', 'everyone'), adder), true);
  assert.equal(A.canAddToGroup({ _id: 'x' }, adder), true);                       // پیش‌فرض: همه
  assert.equal(A.canAddToGroup(mk('b', 'nobody', [adder]), adder), false);        // حتی مخاطب هم نه
  assert.equal(A.canAddToGroup(mk('c', 'contacts', [adder]), adder), true);
  assert.equal(A.canAddToGroup(mk('d', 'contacts', ['other']), adder), false);
  assert.equal(A.canAddToGroup(mk('e', 'nobody', [], true), adder), true);        // ربات
  const r = A.partitionAddable([mk('a', 'everyone'), mk('b', 'nobody'), mk('c', 'contacts'), mk('d', 'contacts', [adder])], adder);
  assert.deepEqual(r.allowed, ['a', 'd']); assert.deepEqual(r.skipped, [{ userId: 'b', reason: 'nobody' }, { userId: 'c', reason: 'contacts' }]);
});
