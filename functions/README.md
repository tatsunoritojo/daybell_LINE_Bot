# LINE Webhook プロキシ

GAS Web App は HTTP ヘッダを取れない仕様のため、LINE Messaging API の署名検証をこの Cloud Functions が肩代わりする。

## 役割

```
LINE Platform
  │  POST /  (x-line-signature ヘッダ付き)
  ▼
Cloud Functions (このリポジトリの functions/)
  │  1. x-line-signature を HMAC-SHA256 で検証
  │  2. 通過したら { proxyToken, payload: 生body } にラップ
  ▼  3. GAS Web App に POST 転送
GAS Web App (../src/main.gs doPost)
       proxyToken 一致を確認 → 既存ロジックへ
```

## 必要な設定

機密値は Secret Manager で保管する。Cloud Functions の環境変数に直接ベタ書きしない。

| Secret 名 | 用途 | 取得元 |
|---|---|---|
| `line-channel-secret` | 署名検証 | LINE Developers コンソール → 対象チャネル → 基本設定 → チャネルシークレット |
| `gas-webhook-url` | 転送先 | GAS スクリプトエディタ → デプロイ → ウェブアプリ URL（`/exec` で終わる） |
| `proxy-shared-secret` | プロキシ↔GAS 間の共有秘密 | 任意のランダム文字列（`openssl rand -hex 32` 推奨）。GAS 側 Script Property `PROXY_SHARED_SECRET` と同じ値にする |

## 初回セットアップ

### 1. Secret Manager に値を登録

```bash
# Secret Manager API を有効化（初回のみ）
gcloud services enable secretmanager.googleapis.com

# 各シークレットを作成
printf 'YOUR_LINE_CHANNEL_SECRET' | gcloud secrets create line-channel-secret --data-file=-
printf 'https://script.google.com/macros/s/xxx/exec' | gcloud secrets create gas-webhook-url --data-file=-
openssl rand -hex 32 | gcloud secrets create proxy-shared-secret --data-file=-
```

`proxy-shared-secret` の値は `gcloud secrets versions access latest --secret=proxy-shared-secret` で取り出せる。GAS 側 Script Property `PROXY_SHARED_SECRET` に同じ値を設定する。

### 2. Cloud Functions のサービスアカウントに Secret 読み取り権限を付与

```bash
PROJECT_ID=$(gcloud config get-value project)
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

for SECRET in line-channel-secret gas-webhook-url proxy-shared-secret; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:${SA}" \
    --role="roles/secretmanager.secretAccessor"
done
```

### 3. デプロイ

```bash
cd functions
npm install
npm run deploy
```

デプロイ完了時に表示される URL（例: `https://lineWebhookProxy-xxxx-an.a.run.app`）を LINE Developers コンソール → 対象チャネル → Messaging API 設定 → Webhook URL に登録する。

## ローカル動作確認

`.env.example` をコピーして `.env` を作り、値を埋めてから:

```bash
cd functions
npm install
# .env から環境変数を読み込んで起動
set -a && source .env && set +a && npm start
```

`http://localhost:8080` でリッスンする。LINE 署名生成は LINE 公式 SDK の検証ツールが手軽。

## ユニットテスト

署名検証の最小ケースを `index.test.js` で検証する。Node 20 標準の `node:test` を使うため追加依存は不要。

```bash
cd functions
npm test
```

テスト内容: 正規署名通過 / 不正署名拒否 / body改変検出 / 空署名拒否 / 長さ不一致での timingSafeEqual 例外回避。

## セキュリティ方針

- secret は HTTP ボディにのみ載せる。URL クエリやヘッダに含めない（Cloud Functions のリクエストログに残るため）
- secret は Secret Manager で保管し、`--set-secrets` で実行時に環境変数として注入する。`--set-env-vars` で平文渡しはしない（公式推奨外）
- `proxyToken` は GAS 側で不一致の場合、200 + 空ボディで黙殺する（攻撃面を露出させないため）
- 署名検証失敗時は 401 を返す
