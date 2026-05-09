# 概要

## 何を解決するか

東城立憲の日常的なタスク管理・目標管理を、**LINE と Google カレンダー**で完結させる。LINE は「いつでも目に入るインターフェース」、Google カレンダーは「予定の SSOT」として組み合わせ、専用アプリを開かずにタスク登録・確認・通知を回す。

## 誰のためか

- **一次対象**: 東城立憲（個人運用）
- **二次対象**: 東城が受託する顧客（クライアントごとに専用デプロイ。SaaS として不特定多数に提供する設計ではない）

## 主要概念

- **タスク登録**: LINE で任意のテキストを送ると、開始時間 → 終了時間 → 目標フラグ の3段階で対話的に Google カレンダーへ登録。フローの状態は Script Properties で管理し、`flowId + stepToken` で古いボタン操作を弾く
- **目標カウントダウン**: カレンダー予定のタイトル先頭に `【目標】` を付けると、朝通知で「○○まであと N 日」と表示される。リッチメニュー「目標設定」で既存予定から選択可能
- **朝夜通知**: 7時に天気 + 目標 + 期限タスク + 1週間後予定、20時に翌日予定を Push する。トリガーは `setTriggers()` で JST 固定
- **Cloud Functions プロキシ**: GAS は HTTP ヘッダを取れないため、LINE 署名検証は Cloud Functions が肩代わりし、`proxyToken` で GAS と認証する

## 状態

**active**（個人運用中、受託展開可能性あり）

## 関連ドキュメント

- 全体 README: [`../README.md`](../README.md)
- セキュリティポリシー: [`../SECURITY.md`](../SECURITY.md)
- リッチメニュー仕様: [`./rich-menu-spec.md`](./rich-menu-spec.md)
- Cloud Functions プロキシ: [`../functions/README.md`](../functions/README.md)
- ADR: [`./decisions/`](./decisions/)
