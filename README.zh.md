# Webhook Delay Service

中文 | [English](README.md) | [日本語](README.ja.md)

一个基于 Cloudflare Workers 和 Durable Objects 的延迟 Webhook 调度服务。用于在接收到构建请求后，延迟指定时间再触发实际的构建 Webhook，有效避免频繁推送导致的重复构建。

## 功能特性

- ⏱️ **延迟调度**：支持自定义延迟时间（秒），在指定时间后触发 Webhook
- 🔄 **自动重试**：Webhook 调用失败时自动重试，采用指数退避策略（1分钟 → 2分钟 → 5分钟）
- 📊 **状态查询**：提供状态查询接口，实时了解调度状态和执行历史
- 🔐 **安全认证**：支持可选的密钥验证，保护服务不被滥用
- 💾 **持久化存储**：使用 Durable Objects 持久化状态，确保调度任务不丢失

## 使用方法

### 1. 触发延迟构建

发送 POST 请求到服务端点，包含以下请求头：

```bash
curl -X POST https://your-worker.workers.dev \
  -H "x-webhook-url: https://api.example.com/build" \
  -H "x-delay-seconds: 60" \
  -H "x-webhook-secret: your-secret-key"  # 可选
```

**请求头说明：**

- `x-webhook-url`（必需）：要延迟触发的 Webhook URL，必须是 http 或 https 协议
- `x-delay-seconds`（必需）：延迟时间（秒），必须是正整数
- `x-webhook-secret`（可选）：如果配置了 `WEBHOOK_SECRET` 环境变量，则必须提供此头部或 URL 参数 `?secret=xxx`

**响应示例：**

```json
{
  "ok": true,
  "scheduledFor": "2025-01-20T10:30:00.000Z",
  "delaySeconds": 60,
  "webhookUrl": "https://api.example.com/build"
}
```

### 2. 查询调度状态

发送 GET 请求到 `/status` 端点：

```bash
curl https://your-worker.workers.dev/status
```

**响应示例：**

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

**字段说明：**

- `lastWebhookAt`：最后一次接收构建请求的时间
- `scheduledFor`：计划执行时间（如果有待执行的构建）
- `lastBuildAt`：最后一次实际执行构建的时间
- `lastBuildStatus`：最后一次构建状态（`success` 或 `error`）
- `lastError`：最后一次错误信息（如果有）
- `retryCount`：当前重试次数
- `delayMs`：延迟时间（毫秒）
- `webhookUrl`：当前配置的 Webhook URL

## 配置方法

### 环境变量

在 `wrangler.jsonc` 或通过 Cloudflare Dashboard 配置以下环境变量：

- `WEBHOOK_SECRET`（可选）：用于验证请求的密钥。如果设置，请求必须提供匹配的 `x-webhook-secret` 头部或 URL 参数

### 本地开发

1. **安装依赖**

```bash
pnpm install
```

2. **启动开发服务器**

```bash
pnpm dev
# 或
pnpm start
```

3. **生成类型定义**

```bash
pnpm cf-typegen
```

### 部署到 Cloudflare

1. **配置 Wrangler**

确保 `wrangler.jsonc` 中的配置正确，特别是 Durable Objects 的绑定配置。

2. **部署**

```bash
pnpm deploy
```

首次部署时，Wrangler 会自动创建 Durable Object 的迁移。后续部署会自动应用迁移。

### 配置示例

在 `wrangler.jsonc` 中添加环境变量（或使用 `wrangler secret put` 命令）：

```jsonc
{
  // ... 其他配置
  "vars": {
    "WEBHOOK_SECRET": "your-secret-key-here"
  }
}
```

或者使用命令行设置密钥（推荐，更安全）：

```bash
wrangler secret put WEBHOOK_SECRET
```

## 工作原理

1. **接收请求**：服务接收 POST 请求，验证参数和密钥（如果配置）
2. **调度任务**：将 Webhook URL 和延迟时间存储到 Durable Object，并设置 Alarm（定时器）
3. **延迟执行**：到达指定时间后，Durable Object 的 `alarm()` 方法被触发
4. **调用 Webhook**：向目标 URL 发送 POST 请求
5. **失败重试**：如果调用失败，自动按指数退避策略重试（最多 3 次）

## 使用场景

- **Git 推送合并**：在频繁推送时，延迟触发构建，避免重复构建
- **批量操作**：等待多个操作完成后再触发构建
- **限流保护**：为构建系统添加延迟缓冲，避免过载

## 注意事项

- 每个 Durable Object 实例（通过 `getByName("scheduler")`）维护独立的状态
- 如果同时有多个延迟任务，新的任务会覆盖之前的调度
- 重试策略：第 1 次重试延迟 1 分钟，第 2 次延迟 2 分钟，第 3 次及以后延迟 5 分钟
- 错误信息会被截断到 500 字符以内

## 开发

项目使用 TypeScript 编写，需要 Node.js 和 pnpm。

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm dev

# 部署
pnpm deploy
```

## License

Private

