# Webhook Delay Service

[中文](README.zh.md) | [English](README.md) | 日本語

Cloudflare Workers と Durable Objects を基盤とした遅延 Webhook スケジューリングサービス。ビルドリクエストを受信し、指定された遅延時間後に実際のビルド Webhook をトリガーし、頻繁なプッシュによる重複ビルドを効果的に防止します。

## 機能

- ⏱️ **遅延スケジューリング**: カスタム遅延時間（秒単位）をサポートし、指定された時間に Webhook をトリガー
- 🔄 **自動リトライ**: Webhook 呼び出しが失敗した場合、指数バックオフ戦略（1分 → 2分 → 5分）で自動的にリトライ
- 📊 **ステータス照会**: ステータス照会エンドポイントを提供し、スケジューリングステータスと実行履歴をリアルタイムで監視
- 🔐 **セキュリティ認証**: オプションのシークレットキー検証をサポートし、サービスの悪用を防止
- 💾 **永続化ストレージ**: Durable Objects を使用して状態を永続化し、スケジュールされたタスクが失われないようにする

## 使用方法

### 1. 遅延ビルドのトリガー

以下のヘッダーを含む POST リクエストをサービスエンドポイントに送信します：

```bash
curl -X POST https://your-worker.workers.dev \
  -H "x-webhook-url: https://api.example.com/build" \
  -H "x-delay-seconds: 60" \
  -H "x-webhook-secret: your-secret-key"  # オプション
```

**リクエストヘッダー:**

- `x-webhook-url`（必須）: 遅延後にトリガーする Webhook URL。http または https プロトコルである必要があります
- `x-delay-seconds`（必須）: 遅延時間（秒）。正の整数である必要があります
- `x-webhook-secret`（オプション）: `WEBHOOK_SECRET` 環境変数が設定されている場合は必須。URL パラメータ `?secret=xxx` としても提供可能

**レスポンス例:**

```json
{
  "ok": true,
  "scheduledFor": "2025-01-20T10:30:00.000Z",
  "delaySeconds": 60,
  "webhookUrl": "https://api.example.com/build"
}
```

### 2. スケジューリングステータスの照会

`/status` エンドポイントに GET リクエストを送信します：

```bash
curl https://your-worker.workers.dev/status
```

**レスポンス例:**

```json
{
  "lastWebhookAt": "2025-01-20T10:29:00.000Z",
  "scheduledFor": "2025-01-20T10:30:00.000Z",
  "lastBuildAt": "2025-01-20T10:25:00.000Z",
  "lastBuildStatus": "success",
  "lastError": null,
  "retryCount": 0,
  "delayMs": 60000,
  "webhookUrl": "https://api.example.com/build"
}
```

**フィールド説明:**

- `lastWebhookAt`: 最後のビルドリクエストを受信した時刻
- `scheduledFor`: スケジュールされた実行時刻（保留中のビルドがある場合）
- `lastBuildAt`: 最後のビルドが実際に実行された時刻
- `lastBuildStatus`: 最後のビルドのステータス（`success` または `error`）
- `lastError`: 最後のエラーメッセージ（ある場合）
- `retryCount`: 現在のリトライ回数
- `delayMs`: 遅延時間（ミリ秒）
- `webhookUrl`: 現在設定されている Webhook URL

## 設定方法

### 環境変数

`wrangler.jsonc` または Cloudflare Dashboard で以下の環境変数を設定します：

- `WEBHOOK_SECRET`（オプション）: リクエスト検証用のシークレットキー。設定されている場合、リクエストは一致する `x-webhook-secret` ヘッダーまたは URL パラメータを提供する必要があります

### ローカル開発

1. **依存関係のインストール**

```bash
pnpm install
```

2. **開発サーバーの起動**

```bash
pnpm dev
# または
pnpm start
```

3. **型定義の生成**

```bash
pnpm cf-typegen
```

### Cloudflare へのデプロイ

1. **Wrangler の設定**

`wrangler.jsonc` の設定が正しいことを確認します。特に Durable Objects のバインディング設定を確認してください。

2. **デプロイ**

```bash
pnpm deploy
```

初回デプロイ時、Wrangler は自動的に Durable Object のマイグレーションを作成します。以降のデプロイでは、マイグレーションが自動的に適用されます。

### 設定例

`wrangler.jsonc` に環境変数を追加するか、`wrangler secret put` コマンドを使用します：

```jsonc
{
  // ... その他の設定
  "vars": {
    "WEBHOOK_SECRET": "your-secret-key-here"
  }
}
```

または、コマンドラインでシークレットを設定します（推奨、より安全）：

```bash
wrangler secret put WEBHOOK_SECRET
```

## 動作原理

1. **リクエスト受信**: サービスが POST リクエストを受信し、パラメータとシークレット（設定されている場合）を検証
2. **タスクスケジューリング**: Webhook URL と遅延時間を Durable Object に保存し、Alarm（タイマー）を設定
3. **遅延実行**: 指定された時間に達すると、Durable Object の `alarm()` メソッドがトリガーされる
4. **Webhook 呼び出し**: ターゲット URL に POST リクエストを送信
5. **失敗時のリトライ**: 呼び出しが失敗した場合、指数バックオフ戦略で自動的にリトライ（最大3回）

## 使用例

- **Git プッシュのマージ**: 頻繁なプッシュ時にビルドトリガーを遅延させ、重複ビルドを回避
- **バッチ操作**: 複数の操作が完了するのを待ってからビルドをトリガー
- **レート制限**: ビルドシステムに遅延バッファを追加し、過負荷を防止

## 注意事項

- 各 Durable Object インスタンス（`getByName("scheduler")` 経由）は独立した状態を維持します
- 複数の遅延タスクが同時に存在する場合、新しいタスクは以前のスケジュールを上書きします
- リトライ戦略: 1回目のリトライは1分、2回目は2分、3回目以降は5分の遅延
- エラーメッセージは500文字以内に切り詰められます

## 開発

このプロジェクトは TypeScript で記述されており、Node.js と pnpm が必要です。

```bash
# 依存関係のインストール
pnpm install

# 開発モード
pnpm dev

# デプロイ
pnpm deploy
```

## License

Private

