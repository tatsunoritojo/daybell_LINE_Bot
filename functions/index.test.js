// プロキシの署名検証ユニットテスト
// 実行: npm test  (Node 20+ の標準テストランナー node:test を使用、追加依存なし)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifyLineSignature } = require('./index');

const SECRET = 'test_channel_secret_for_unit_tests';
const BODY = JSON.stringify({
  destination: 'Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  events: [{ type: 'message', message: { type: 'text', text: 'hello' } }],
});

function sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

test('正しい署名は受理される', () => {
  const sig = sign(BODY, SECRET);
  assert.equal(verifyLineSignature(BODY, sig, SECRET), true);
});

test('不正な署名は拒否される', () => {
  const wrongSig = sign(BODY, 'wrong_secret');
  assert.equal(verifyLineSignature(BODY, wrongSig, SECRET), false);
});

test('body が改変されると署名は一致しなくなる', () => {
  const sig = sign(BODY, SECRET);
  const tamperedBody = BODY.replace('hello', 'goodbye');
  assert.equal(verifyLineSignature(tamperedBody, sig, SECRET), false);
});

test('署名ヘッダが空文字なら拒否される', () => {
  assert.equal(verifyLineSignature(BODY, '', SECRET), false);
});

test('署名ヘッダが undefined / null でも例外にならず false を返す', () => {
  assert.equal(verifyLineSignature(BODY, undefined, SECRET), false);
  assert.equal(verifyLineSignature(BODY, null, SECRET), false);
});

test('長さの異なる署名は timingSafeEqual の手前で弾かれる', () => {
  // timingSafeEqual は長さ不一致で例外を投げる仕様。事前チェックで false を返すことを確認
  assert.equal(verifyLineSignature(BODY, 'short', SECRET), false);
});
