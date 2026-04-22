// daybell LINE Webhook proxy
//
// 役割:
//   1. LINE Platform から受け取った Webhook の x-line-signature を生body + Channel Secret で検証する
//   2. 検証通過したリクエストのみを GAS Web App に転送する
//   3. GAS は HTTPヘッダを取れない仕様のため、proxyToken を JSON body に埋めて共有秘密として渡す
//
// 環境変数:
//   LINE_CHANNEL_SECRET   LINE Developers のチャネル基本設定にあるチャネルシークレット
//   GAS_WEBHOOK_URL       GAS Web App のデプロイURL（/exec で終わる）
//   PROXY_SHARED_SECRET   GAS 側 Script Property と一致させる任意の長いランダム文字列
//
// セキュリティ方針:
//   - secret は HTTPボディ内にのみ載せる（ログ・URL・referer に残さない）
//   - 署名不一致は 401 を返す（攻撃面を見せない選択もあるが、LINE 公式の検証ガイドに合わせる）
//   - GAS 側は proxyToken 不一致を 200 + 空ボディで黙殺する（攻撃面を露出させない）

const crypto = require('crypto');
const functions = require('@google-cloud/functions-framework');

functions.http('lineWebhookProxy', async (req, res) => {
  // POST 以外は LINE Webhook ではないので即拒否
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const gasWebhookUrl = process.env.GAS_WEBHOOK_URL;
  const proxySharedSecret = process.env.PROXY_SHARED_SECRET;

  if (!channelSecret || !gasWebhookUrl || !proxySharedSecret) {
    // 設定漏れは 500 で落とす。LINE には再送されるが、その間に運用者が直す前提
    console.error('Missing required env vars');
    res.status(500).send('Server misconfigured');
    return;
  }

  // 生body を文字列で取得する。functions-framework は req.rawBody (Buffer) を提供する
  // JSON.stringify(req.body) で再シリアライズすると LINE の元バイト列と一致せず HMAC が崩れるため必ず rawBody を使う
  const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
  const signature = req.get('x-line-signature') || '';

  if (!verifyLineSignature(rawBody, signature, channelSecret)) {
    console.warn('Signature verification failed');
    res.status(401).send('Invalid signature');
    return;
  }

  // GAS に転送するペイロード。LINE が送ってきた生 body を payload に文字列のまま格納する
  // GAS 側は body.proxyToken をチェック → 一致したら body.payload を JSON.parse して既存ロジックへ
  const wrapped = {
    proxyToken: proxySharedSecret,
    payload: rawBody,
  };

  try {
    const upstream = await fetch(gasWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wrapped),
      // GAS の doPost はリダイレクトで実体URLに飛ぶことがあるので redirect: 'follow' を明示
      redirect: 'follow',
    });

    // GAS 側のレスポンス（多くは空 or 短いテキスト）をそのまま LINE に返す
    // LINE は Webhook レスポンスの本文を見ないが、ステータスコードは見る
    const text = await upstream.text();
    res.status(upstream.status).send(text);
  } catch (err) {
    // 転送失敗時は 502 を返し、LINE の自動再送に委ねる
    console.error('Forward to GAS failed:', err && err.message ? err.message : err);
    res.status(502).send('Bad Gateway');
  }
});

// LINE Messaging API の署名検証
// 公式仕様: HMAC-SHA256(channelSecret, requestBody) を Base64 した値を x-line-signature ヘッダと比較する
function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', channelSecret)
    .update(rawBody, 'utf8')
    .digest('base64');
  // タイミング攻撃対策に timingSafeEqual を使う。長さ不一致は事前に弾く
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { verifyLineSignature };
