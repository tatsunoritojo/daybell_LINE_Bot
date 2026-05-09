# 0001: 個人用前提への巻き戻し（マルチテナント化の撤回）

## Status

Accepted (2026-05-09)

## Context

2026-04-23 から **マルチテナント対応**（友だち追加した第三者が各自の Google カレンダーで利用できる構成）への再設計を進めていた。具体的には:

- `feature/multi-tenant-notify` ブランチで GAS を 6 ファイルに分割（`6567b38` から `c53f979` まで）
- ユーザー個別の Google OAuth 認可導線を実装
- Cloud Functions プロキシ（`functions/`）を前段に置き署名検証
- ユーザー台帳を Spreadsheet で管理、各ユーザーの primary calendar に REST API で読み書き
- `proxyToken` 共有秘密で Cloud Functions ↔ GAS 間を認証

しかし以下の問題が継続的に発生・蓄積した:

1. **Google API verification の壁**: 不特定多数公開には `calendar.events` スコープの Sensitive/Restricted 判定 + CASA audit が必要。個人開発の射程外（数千ドル規模のコスト・数ヶ月の verification プロセス）
2. **Phase 4 認可問題**: GAS 側で `SpreadsheetApp.openById` / `Session.getEffectiveUser` が permission denied になり、認可ダイアログも起動しない状態でデバッグが詰まっていた
3. **セキュリティ運用負荷**: マルチテナント版の独立レビュー（Codex MCP + Claude）で、`proxyToken` 単一固定秘密 / 本番デバッグ関数残存 / `ScriptProperties` 全テナント集約 / `oauthScopes` 自動推論 / `LINE_CHANNEL_SECRET` GAS 側複製 など High/Medium 複数の指摘を受けた。修正コストが継続的に発生する見通し
4. **販売モデルの再評価**: 「不特定多数 SaaS 公開」ではなく「**受託案件としてクライアントごとデプロイ**」のほうが、現在の射程に合う

加えて、運用観察として「**個人の範囲だったら余裕で動いていた**」という事実があり、マルチテナント化が overkill だったと判断する材料になった。

## Decision

マルチテナント版（`feature/multi-tenant-notify`、`6567b38` から `c53f979` までの 3 commits + 未コミットの Phase 4 デバッグ作業）を排除し、main を **個人用最終版 `f182dfd`**（署名検証プロキシ + clasp 運用基盤を追加）にロールバックする。

今後の販売モデルは「**個人用 + 受託納品の二本立て**」とし、依頼があった場合はクライアントごとに専用デプロイ（独立した LINE Channel + GCP project）で対応する。

## Consequences

### 良い面
- Google API verification が不要（Test Users 100 名以内 or 個別 GCP project で完結）
- セキュリティ運用負荷が大幅に減る（OAuth ライブラリ廃止、`ScriptProperties` 集約問題は単一ユーザーなら無害）
- Phase 4 認可問題は構造的に発生しなくなる（マルチテナント由来の複雑性の副作用だった）
- コードベースが約 1/3〜1/2 簡潔になる
- 署名検証プロキシ（`functions/`）は個人用でも有用なので維持

### 悪い面・トレードオフ
- マルチテナント設計の試行に投じた工数は main 上では失われる（git の reflog / GitHub event log には残る）
- 受託納品のたびに環境構築手順が必要（`README.md` で手順を整備）

### 副次的な事項
- マルチテナント設計を試行・撤回した経緯自体が**判断力の実績**として ADR に残る
- 今後マルチテナント化を再検討する場合は、本 ADR と当時の commits を参照
