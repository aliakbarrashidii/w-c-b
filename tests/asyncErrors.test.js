// تست بدون نیاز به دیتابیس: یک خطای هندلر async نباید پروسه رو بکشه (قبلاً GET با ObjectIdِ خراب کل سرور رو از کار می‌انداخت).
process.env.JWT_SECRET = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/utils/asyncErrors');
const express = require('express');
const mongoose = require('mongoose');

test('خطای async → ۴۰۰/۵۰۰ با میدل‌ویر خطا و سرور زنده می‌مونه', async () => {
  const Model = mongoose.model('AsyncErrTest', new mongoose.Schema({ a: String }));
  const app = express();
  app.get('/chats/:id', async (req, res) => { await Model.findById(req.params.id); res.json({ ok: true }); });
  app.get('/sync', () => { throw new Error('sync boom'); });
  app.get('/ok', (req, res) => res.json({ ok: true }));
  app.use((err, req, res, next) => res.status(err.name === 'CastError' ? 400 : 500).json({ error: 'x' })); // eslint-disable-line no-unused-vars
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    assert.equal((await fetch(`${base}/chats/not-an-id`)).status, 400);
    assert.equal((await fetch(`${base}/sync`)).status, 500);
    assert.equal((await fetch(`${base}/ok`)).status, 200, 'سرور باید بعد از خطا زنده باشه');
  } finally {
    srv.close();
  }
});
