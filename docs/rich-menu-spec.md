# リッチメニュー 設計仕様

`予定お知らせ君` のリッチメニュー（LINE画面下部の常設操作パネル）の設計書。

- コンセプト画像: [`rich-menu-concept.svg`](rich-menu-concept.svg)
- サイズ: **2500 × 1686 px**（LINE Messaging API リッチメニュー Large）
- 分割: **上下 2ボタン**

## レイアウト

|     | 機能 | タップ時の送信テキスト |
|---|---|---|
| **上段** (y: 0-843) | 🚩 目標設定 | `目標設定` |
| **下段** (y: 843-1686) | 📅 予定確認 | `予定確認` |

## 各ボタンの挙動

| ボタン | ボット側の処理 |
|---|---|
| 目標設定 | 既存の `showGoalSelection()` を発火（直近半年の予定から目標候補を提示） |
| 予定確認 | **新規実装** 直近 1 週間分のカレンダー予定を整形して返信 |

## クリック領域の座標（LINE API `richmenu` 登録用）

```json
{
  "size": { "width": 2500, "height": 1686 },
  "selected": true,
  "name": "予定お知らせ君メニュー",
  "chatBarText": "メニュー",
  "areas": [
    {
      "bounds": { "x": 0, "y": 0, "width": 2500, "height": 843 },
      "action": { "type": "message", "text": "目標設定" }
    },
    {
      "bounds": { "x": 0, "y": 843, "width": 2500, "height": 843 },
      "action": { "type": "message", "text": "予定確認" }
    }
  ]
}
```

## 画像の使い方

1. `rich-menu-concept.svg` を PNG に書き出し（2500×1686）
   - ブラウザで SVG を開いて画面キャプチャ、または `rsvg-convert` / `magick` / Inkscape 等でエクスポート
2. LINE Official Account Manager のリッチメニュー編集画面で「画像を変更」→ PNG をアップロード
   - テンプレートは「大・2分割（上下）」を選択
   - アクションA（上）: テキスト送信 `目標設定`
   - アクションB（下）: テキスト送信 `予定確認`

## 実装タスク（コード側）

- [ ] `main.gs` の `doPost` に `予定確認` 受信時の分岐を追加
- [ ] 直近 1 週間の予定を整形する関数 `replyUpcomingWeekSchedule(replyToken)` を新設
  - カレンダーから `今日〜7日後` の予定を取得
  - 日付ごとにグループ化し、終日・時間指定を区別して整形
  - `【リマインド】` を含むタイトルは予定一覧から省略（夜の通知で別途扱う）
