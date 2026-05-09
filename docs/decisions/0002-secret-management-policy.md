# 0002: シークレット管理方針

## Status

Accepted (2026-05-09)

## Context

本プロジェクトは個人運用 + 受託納品の二本立て（[`0001-rollback-to-single-user.md`](0001-rollback-to-single-user.md) 参照）。シークレット（LINE チャネルアクセストークン、Channel Secret、`proxyToken` 等）の管理ポリシーを明確にする必要がある。

主な制約:

1. **GAS の Script Properties は平文保存**。GAS 側からの暗号化保管手段が公式に提供されていない（2026-05 時点）
2. **Cloud Functions は Secret Manager 連携が可能**。`--set-secrets` で実行時に環境変数として注入できる
3. **`clasp push` は Script Properties を上書きしない**。`appsscript.json` は上書きするが、Properties は GAS UI 側のデータとして独立して管理される
4. **受託納品時の運用**: クライアントが自分の GCP project + LINE Channel を持つ前提。値は別チャネル（暗号化メール、対面、Bitwarden 共有等）で東城と共有し、東城は値を永続的に保持しない運用が望ましい

## Decision

| レイヤー | 保管先 | 平文 / 暗号化 | 管理方法 |
|---|---|---|---|
| Cloud Functions | **Secret Manager** | 暗号化 | `--set-secrets KEY=secret:latest` で注入 |
| GAS | **Script Properties** | 平文（GAS 制約） | 初回のみ `setup()` で雛形作成、値は GAS UI で手入力。`PROXY_SHARED_SECRET` は推奨構成（`main.gs` の `doPost` に `proxyToken` 検証分岐を追加した場合）でのみ使用 |
| ローカル開発 | **`.secrets/` ディレクトリ**（`.gitignore` 対象） | 平文 | バックアップ用途、本番動作には影響しない |
| リポジトリ | **コミットしない** | — | `.gitignore` で `.secrets/`、`.env*`、`credentials.json`、`*.secret` を除外 |

### 受託納品時の手順

1. クライアントが LINE Channel を発行（または東城が代理発行）
2. クライアント名義（または専用）の GCP project を作成
3. Secret Manager に必要な値（LINE Channel Secret、`PROXY_SHARED_SECRET` 等）を登録（[`functions/README.md`](../../functions/README.md) 手順）
4. GAS Script Properties に必要な値（`LINE_ACCESS_TOKEN`、`LINE_USER_ID`、`TARGET_CALENDAR_ID` 等）を手入力（[`README.md`](../../README.md) 手順）
5. **引き渡し後の必須作業**（東城が値を保持しない運用を担保するため）:
   - LINE Channel Access Token を再発行（旧トークンを失効させる）
   - `PROXY_SHARED_SECRET` を再生成し、Secret Manager と GAS Properties の両方を更新
   - Secret Manager IAM / GAS スクリプト共有から東城のアカウントを除外
6. 以降、値の管理責任はクライアント側にある

### 機密ファイル取扱いの規律

- **中身を読まずに保管・移動**する
- 誤って中身を露出させた場合は即座にローテーション（再発行）
- 破壊的 git 操作（`clean -fd` / `restore .` / `reset --hard`）の前に `.secrets/` を別パスにバックアップ + `git clean -nd` で dry-run 確認

## Consequences

### 良い面
- Cloud Functions 側の漏洩面が小さい（Secret Manager 経由）
- Script Properties は `clasp push` で消えない（コード差し替えで秘匿値が吹き飛ばない）
- 納品先が自分で値を管理できる（東城が永続的に値を持つ運用ではない）

### 悪い面・トレードオフ
- GAS 側 Script Properties は平文。スクリプトエディタへのアクセス権を持つ人は読める
  - 緩和策: GAS スクリプトの「編集者」を最小化（基本は本人のみ）
- 納品時の手順が手動オペレーション中心
  - 緩和策: `README.md` にステップを明記、頻度が増えれば automation 化を検討

### 既知の制約
- GAS Script Properties の暗号化機能は将来の Google 側機能追加を待つ（2026-05 時点で未提供）
- 暗号化が必要な機密情報は Cloud Functions 側に寄せる設計を選ぶ
