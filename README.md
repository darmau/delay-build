# Webhook Delay Service

[中文](README.zh.md) | English | [日本語](README.ja.md)

A delayed webhook scheduling service built on Cloudflare Workers and Durable Objects. It receives build requests and triggers the actual build webhook after a specified delay, effectively preventing duplicate builds caused by frequent pushes.

## Features

- ⏱️ **Delayed Scheduling**: Support custom delay time (in seconds) to trigger webhooks at specified times
- 🔄 **Auto Retry**: Automatically retry failed webhook calls with exponential backoff strategy (1 min → 2 min → 5 min)
- 📊 **Status Query**: Provides status query endpoint to monitor scheduling status and execution history in real-time
- 🔐 **Security Authentication**: Optional secret key verification to protect the service from abuse
- 💾 **Persistent Storage**: Uses Durable Objects for persistent state, ensuring scheduled tasks are not lost

## Usage

### 1. Trigger Delayed Build

Send a POST request to the service endpoint with the following headers:

```bash
curl -X POST https://your-worker.workers.dev \
  -H "x-webhook-url: https://api.example.com/build" \
  -H "x-delay-seconds: 60" \
  -H "x-webhook-secret: your-secret-key"  # Optional
```

**Request Headers:**

- `x-webhook-url` (required): The webhook URL to be triggered after delay. Must be http or https protocol
- `x-delay-seconds` (required): Delay time in seconds. Must be a positive integer
- `x-webhook-secret` (optional): Required if `WEBHOOK_SECRET` environment variable is configured. Can also be provided as URL parameter `?secret=xxx`

**Response Example:**

```json
{
  "ok": true,
  "scheduledFor": "2025-01-20T10:30:00.000Z",
  "delaySeconds": 60,
  "webhookUrl": "https://api.example.com/build"
}
```

### 2. Query Scheduling Status

Send a GET request to the `/status` endpoint:

```bash
curl https://your-worker.workers.dev/status
```

**Response Example:**

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

**Field Descriptions:**

- `lastWebhookAt`: Time when the last build request was received
- `scheduledFor`: Scheduled execution time (if there's a pending build)
- `lastBuildAt`: Time when the last build was actually executed
- `lastBuildStatus`: Status of the last build (`success` or `error`)
- `lastError`: Last error message (if any)
- `retryCount`: Current retry count
- `delayMs`: Delay time in milliseconds
- `webhookUrl`: Currently configured webhook URL

## Configuration

### Environment Variables

Configure the following environment variables in `wrangler.jsonc` or via Cloudflare Dashboard:

- `WEBHOOK_SECRET` (optional): Secret key for request verification. If set, requests must provide a matching `x-webhook-secret` header or URL parameter

### Local Development

1. **Install Dependencies**

```bash
pnpm install
```

2. **Start Development Server**

```bash
pnpm dev
# or
pnpm start
```

3. **Generate Type Definitions**

```bash
pnpm cf-typegen
```

### Deploy to Cloudflare

1. **Configure Wrangler**

Ensure the configuration in `wrangler.jsonc` is correct, especially the Durable Objects binding configuration.

2. **Deploy**

```bash
pnpm deploy
```

On first deployment, Wrangler will automatically create Durable Object migrations. Subsequent deployments will automatically apply migrations.

### Configuration Example

Add environment variables in `wrangler.jsonc` (or use `wrangler secret put` command):

```jsonc
{
  // ... other configuration
  "vars": {
    "WEBHOOK_SECRET": "your-secret-key-here"
  }
}
```

Or use the command line to set secrets (recommended, more secure):

```bash
wrangler secret put WEBHOOK_SECRET
```

## How It Works

1. **Receive Request**: Service receives POST request and validates parameters and secret (if configured)
2. **Schedule Task**: Stores webhook URL and delay time in Durable Object and sets an Alarm (timer)
3. **Delayed Execution**: When the specified time is reached, the Durable Object's `alarm()` method is triggered
4. **Call Webhook**: Sends POST request to target URL
5. **Failure Retry**: If the call fails, automatically retries with exponential backoff strategy (up to 3 times)

## Use Cases

- **Git Push Merging**: Delay build triggers during frequent pushes to avoid duplicate builds
- **Batch Operations**: Wait for multiple operations to complete before triggering builds
- **Rate Limiting**: Add delay buffer for build systems to prevent overload

## Notes

- Each Durable Object instance (via `getByName("scheduler")`) maintains independent state
- If multiple delayed tasks exist simultaneously, new tasks will override previous schedules
- Retry strategy: 1st retry delays 1 minute, 2nd retry delays 2 minutes, 3rd and subsequent retries delay 5 minutes
- Error messages are truncated to 500 characters

## Development

The project is written in TypeScript and requires Node.js and pnpm.

```bash
# Install dependencies
pnpm install

# Development mode
pnpm dev

# Deploy
pnpm deploy
```

## License

Private
