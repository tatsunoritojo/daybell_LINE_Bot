# daybell LINE Bot（予定お知らせ君）

東城立憲の個人用 LINE Bot。Google カレンダーと連携し、対話型で予定登録・朝夜の自動通知（天気 + タスク + 目標カウントダウン）を行う。受託案件としてクライアントごとデプロイする方式（OEM 納品）にも展開可能な構成。

## 構成

| パス | 役割 |
|---|---|
| `src/main.gs` | doPost / Webhook ハンドラ・タスク登録フロー・予定確認・朝夜通知 |
| `src/appsscript.json` | GAS マニフェスト（V8、oauthScopes 4個） |
| `functions/index.js` | Cloud Functions プロキシ（LINE 署名検証 + GAS 転送） |
| `functions/index.test.js` | 署名検証ユニットテスト 6 ケース |
| `docs/decisions/` | ADR（設計判断記録） |
| `docs/preview/` | 通知メッセージのプレビュー（HTML/CSS） |
| `.secrets/` | 秘密情報（gitignored、本番は Secret Manager / Script Properties） |

## 主要技術スタック

- Google Apps Script（V8）, `clasp`
- Cloud Functions Gen 2（Node.js 20, asia-northeast1）
- Google Cloud Secret Manager
- LINE Messaging API / Google Calendar (CalendarApp)

## 運用コマンド

詳細は [`README.md`](README.md) と [`functions/README.md`](functions/README.md) 参照。

## 固有のルール

- **個人用 + 受託納品の二本立て**。不特定多数 SaaS 公開は射程外。経緯は [`docs/decisions/0001-rollback-to-single-user.md`](docs/decisions/0001-rollback-to-single-user.md)
- 設定値は Script Properties に外出し（`LINE_ACCESS_TOKEN` / `LINE_USER_ID` 等）。コード直書き禁止。シークレット管理の詳細は [`docs/decisions/0002-secret-management-policy.md`](docs/decisions/0002-secret-management-policy.md)
- `clasp push` は `appsscript.json` も上書きする。ライブラリ依存は GAS エディタで追加 → `clasp pull` で反映
- 機密情報を含むファイル（`.secrets/`、Script Properties 値）は中身を読まずに保管・移動する
- 破壊的 git 操作（`clean -fd` / `restore .` / `reset --hard`）は事前バックアップ + dry-run（`git clean -nd`）必須

## 次セッション着手用

（必要に応じて随時更新）
