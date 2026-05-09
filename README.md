# 予定お知らせ君

<img src="icon.png" alt="予定お知らせ君 アイコン" width="200" align="right">

Googleカレンダーと連携して、予定を LINE で対話的に登録・通知してくれる Google Apps Script (GAS) 製の LINE ボットです。LINE で友だち追加すると **「予定お知らせ君」** という名前で登場します（リポジトリ上のコード名は `daybell`）。

## 主な機能

- **対話型タスク登録** — LINE にメッセージを送ると、開始時間 → 終了時間 → 目標フラグの順に GUI で聞いてきて Google カレンダーに登録。開始日と終了日が2日以上離れる予定は自動的に「終日イベント」として登録され、GCal の上部バーにきれいに収まる
- **リッチメニュー** — LINE画面下部の常設メニュー（上下2分割）で「目標設定」「予定確認」をワンタップ起動
- **目標カウントダウン** — 「目標設定」メニューで既存予定を目標に指定すると、朝通知で「○○まであと N 日」と毎日カウントダウン
- **予定確認** — 「予定確認」メニューで、今日から7日間のカレンダー予定を日付別の Flex Message で一覧表示
- **朝の通知** — 毎朝7時に、天気予報（気象庁API） + 目標カウントダウン + 期限が迫るタスク + 1週間後の予定を Flex Message でまとめて配信
- **夜の通知** — 毎晩20時に、翌日の予定を Flex Message で配信（ごみ出し等の繰り返し予定も通常の予定として並ぶ）

## 画面イメージ

通知メッセージの見た目は [`docs/preview/index.html`](docs/preview/index.html) をブラウザで開くと確認できます（HTML/CSSによる近似プレビュー）。リッチメニューの設計コンセプトは [`docs/rich-menu-concept.svg`](docs/rich-menu-concept.svg) を参照。

## 技術スタック

- Google Apps Script (GAS)
- LINE Messaging API
- Google Calendar API (CalendarApp)
- 気象庁 天気予報 API

---

> **設計方針**: 個人用運用と受託納品（クライアントごとデプロイ）の二本立て。不特定多数 SaaS 公開は射程外。詳細は [`docs/decisions/0001-rollback-to-single-user.md`](docs/decisions/0001-rollback-to-single-user.md) 参照。

## 開発ワークフロー (clasp 運用)

GAS ソースは [clasp](https://github.com/google/clasp) でローカル ↔ Apps Script を同期する。`src/appsscript.json` がプロジェクトのマニフェストで、Web App 設定や OAuth スコープを宣言している。`.clasp.json`（接続情報）は環境ごとに異なるのでコミット対象外。

### 初回セットアップ

```bash
# clasp をグローバルインストール
npm install -g @google/clasp

# Google アカウントでログイン
clasp login

# このリポジトリのルートで、対象 GAS プロジェクトと紐付け
# scriptId は GAS スクリプトエディタ → プロジェクトの設定 → スクリプトID で確認
clasp clone <scriptId> --rootDir ./src
```

`clasp clone` 後に重複ファイルが作られることがあるので、`./src/main.gs` と `./src/appsscript.json` だけが残るように整理する。

### 日常開発

```bash
clasp pull   # GAS エディタ側の変更をローカルに取り込む
clasp push   # ローカルの変更を GAS にアップロード
clasp open   # GAS エディタをブラウザで開く
```

OAuth2 ライブラリのような GAS 側でのみ管理されるライブラリ依存は、エディタで追加してから `clasp pull` で `appsscript.json` に反映される。

## Webhook プロキシ (Cloud Functions)

GAS 単体では `x-line-signature` ヘッダを取得できないため、署名検証は [`functions/`](functions/) の Cloud Functions プロキシが肩代わりする。詳細は [`functions/README.md`](functions/README.md) を参照。

---

## セットアップ手順

自分の環境にこのボットをデプロイする手順です。クライアントへの受託納品も基本的に同じ手順をクライアント環境で行いますが、追加の分離方針については後述「受託納品時のセットアップ」を参照してください。

### 前提条件

- Google アカウント
- LINE アカウント
- LINE Developers アカウント（無料）

### 1. LINE Messaging API チャネルを作成

1. [LINE Developers Console](https://developers.line.biz/console/) にログイン
2. プロバイダーを作成（既存のものを使ってもOK）
3. 「Messaging API」チャネルを新規作成
4. 以下をメモしておく:
   - **チャネルアクセストークン（長期）** — 「Messaging API設定」タブの下部で発行
   - **あなた自身のユーザーID** — 「チャネル基本設定」タブ内に記載の `U` から始まるID
5. 「応答メッセージ」「あいさつメッセージ」を無効化、「Webhook の利用」を有効化

### 2. Google Apps Script プロジェクトを作成してコードを貼る

1. [Google Apps Script](https://script.google.com/) を開き、「新しいプロジェクト」
2. 初期の `コード.gs` の中身をすべて削除
3. このリポジトリの [`src/main.gs`](src/main.gs) の内容をコピー＆ペースト
4. プロジェクト名を好きな名前に（例: `予定お知らせ君`）

### 3. 設定値を Script Properties に登録

コードには秘匿値を直書きしません。Script Properties で管理します。

1. GAS エディタで関数一覧から `setup` を選択 → 「実行」（初回は権限承認）
   - 必要なキーの雛形が空の値で作成されます
2. スクリプトエディタ左のメニュー → **「プロジェクトの設定」（歯車）** → 画面下部の **「スクリプト プロパティ」** → 「スクリプト プロパティを追加」または既存キーを編集
3. 以下の値を設定:

| キー | 説明 |
|---|---|
| `LINE_ACCESS_TOKEN` | LINE Developers で発行したチャネルアクセストークン（長期） |
| `LINE_USER_ID` | あなた自身の LINE ユーザーID (`U...` で始まる) |
| `TARGET_CALENDAR_ID` | 対象カレンダーの ID（空にすると主カレンダー） |
| `WEATHER_AREA_CODE` | 気象庁エリアコード（任意、デフォルト `130000` = 東京） |
| `WEATHER_AREA_LABEL` | 天気予報の表示ラベル（任意、デフォルト `東京`） |

`LINE_ACCESS_TOKEN` / `LINE_USER_ID` が未設定だとボットは反応しません。`TARGET_CALENDAR_ID` は主カレンダーで良ければ空のままで OK。

### 4. Webアプリとしてデプロイ

1. GAS 画面右上の「デプロイ」→「新しいデプロイ」
2. 種類:「ウェブアプリ」
3. 設定:
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**
4. 「デプロイ」を押し、権限を承認
5. 発行された **ウェブアプリURL** をコピー

### 5. LINE 側に Webhook URL を登録

1. LINE Developers Console → 作成したチャネル → 「Messaging API設定」タブ
2. 「Webhook URL」に 4 でコピーした URL を貼り付け → 「更新」
3. 「検証」ボタンで成功することを確認
4. 「Webhook の利用」を ON にする

### 6. 友だち追加

同じく「Messaging API設定」タブにある QR コードを自分のスマホで読み取り、ボットを友だち追加。

### 7. 時間トリガーを設定

朝夜の自動通知を有効化するため、GAS で一度だけトリガー設定関数を走らせます。

1. GAS エディタで関数一覧から `setTriggers` を選択
2. 「実行」ボタンを押す（初回は権限承認）
3. 「トリガー」メニューで `notifyMorning` と `notifyNight` が登録されていることを確認（いずれもJST基準で各時刻前後±15分で発火）

### 8. リッチメニューを登録（任意）

LINE画面下部に常設のクイックメニューを置きたい場合:

1. メニュー用の画像をPNGで用意（推奨 2500×1686px、上下2分割レイアウト）
   - コンセプトは [`docs/rich-menu-concept.svg`](docs/rich-menu-concept.svg) を参照。画像生成AI用のプロンプト雛形は [`docs/rich-menu-spec.md`](docs/rich-menu-spec.md) に記載
2. [LINE Official Account Manager](https://manager.line.biz/) にログイン → 対象アカウントを選択
3. 左メニュー「トークルーム管理」→「リッチメニュー」→「作成」
4. テンプレート: 「大（2分割・上下）」を選択
5. 画像をアップロード
6. アクション設定:
   - 上段（A）: タイプ「テキスト」、内容「目標設定」
   - 下段（B）: タイプ「テキスト」、内容「予定確認」
7. メニューバーのテキストを設定（例: `メニュー`）→ 表示期間を「今すぐ」→ 「保存」

これでセットアップ完了です。

---

## 使い方

| ユーザー操作 | ボットの動き |
|---|---|
| 任意のメッセージを送る（例:「買い物」） | タスク名として扱い、開始時間 → 終了時間 → 目標フラグを対話式で聞いてカレンダーに登録 |
| `目標設定` と送る（リッチメニュー上段） | 直近半年のカレンダー予定から目標を選択するメニューを表示 |
| `予定確認` と送る（リッチメニュー下段） | 今日から7日間の予定を日付ごとにまとめて表示 |
| 何もしない（毎朝7時） | 天気 + 目標カウントダウン + 期限が迫るタスク + 1週間後の予定を自動配信 |
| 何もしない（毎晩20時） | 翌日の予定を自動配信 |

### カレンダーの命名ルール

| タイトルの接頭辞 | 意味 |
|---|---|
| `【目標】○○` | 朝通知でカウントダウン表示される |
| `【タスク】○○` | 期限3日前から朝通知に出る |
| その他（接頭辞なし） | 通常の予定。夜通知の「明日の予定」や予定確認に表示される |

---

## カスタマイズ

### 天気予報のエリア・ラベルを変える

**Script Properties** で以下を書き換えるだけで OK（コード編集不要）。

| キー | 例 |
|---|---|
| `WEATHER_AREA_CODE` | `340000`（広島） |
| `WEATHER_AREA_LABEL` | `広島` |

コードは変更せず、値だけ書き換えて保存。次回通知から反映されます。エリアコード一覧は [気象庁の予報区コード](https://www.jma.go.jp/bosai/common/const/area.json) を参照。

### 使うカレンダーを変える

`TARGET_CALENDAR_ID` に対象カレンダーのIDを設定してください。空にすれば主カレンダーが使われます。カレンダーIDは Google カレンダーの「設定と共有」画面で確認できます（`xxxxx@group.calendar.google.com` 形式）。

### 通知時間を変える

`setTriggers()` 内の `.atHour(7)` と `.atHour(20)` を書き換えて、再度 `setTriggers` を実行してください。既存の `notifyMorning` / `notifyNight` トリガーは自動で置き換わります（他のトリガーは巻き添えになりません）。

---

## 注意事項

### セキュリティ

詳細は [SECURITY.md](SECURITY.md) にまとめています。要点のみ:

- 秘匿値（`LINE_ACCESS_TOKEN` 等）は Script Properties に保存するため、コード公開時に漏れません
- **署名検証（`x-line-signature` 検証）は未実装**。GAS の `doPost` はHTTPヘッダを受け取れない構造的制約のため。代わりに `LINE_USER_ID` ホワイトリストで限定運用します
- 個人用・単一ユーザー前提の設計。家族や他ユーザーにも使わせたい場合は改修が必要

### 利用枠

- GAS の無料枠には 1 日あたりの実行回数・時間制限があります。個人利用の範囲であれば通常問題ありません
- LINE Messaging API のフリープランは月 200 通までの push 通知に制限されています（reply は無制限）。朝夜の通知は push なので、1人で使う分には余裕がありますが、複数人で共有する際は注意

## 受託納品時のセットアップ

クライアント案件として本ボットをデプロイする場合、上記「セットアップ手順」をクライアント環境で実施することに加え、以下を分離する。

### クライアント環境分離

| 項目 | 分離方針 |
|---|---|
| LINE Channel | クライアントが新規発行（または東城が代理発行してクライアントへ引き渡し） |
| GCP project | クライアント名義（または受託専用）で新規作成 |
| Spreadsheet | 必要に応じて新規作成 |
| Cloud Functions | クライアントの GCP project にデプロイ（[`functions/README.md`](functions/README.md) 手順） |

### 値の引き渡し

- LINE Channel Secret / Channel Access Token は別チャネル（暗号化メール、対面、Bitwarden 共有等）で受け渡す
- `PROXY_SHARED_SECRET` はランダム生成（`openssl rand -hex 32`）して Secret Manager と GAS Script Properties に同じ値を登録
- 値の管理責任は引き渡し後にクライアント側に移る。東城は値を保持しない運用が望ましい

詳細なシークレット管理方針は [`docs/decisions/0002-secret-management-policy.md`](docs/decisions/0002-secret-management-policy.md) 参照。

## ライセンス

[MIT License](LICENSE)
