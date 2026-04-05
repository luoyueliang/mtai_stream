# GitHub Copilot 项目指令

本文件为 mtai_stream（流式代理中间层）提供 GitHub Copilot 代码建议的上下文和规范。

## 🎯 项目概述

**项目名称:** mtai_stream — 流式代理中间层  
**技术栈:** Node.js 22 + TypeScript 5 + Fastify 5 + ioredis 5  
**架构定位:** backend 与 AI 供应商（dify/apisvr）之间的 SSE 流式协议转换中间层

```
front (UI) → backend (鉴权/积分/Task) → stream (SSE 流式代理) → dify | apisvr
```

**核心职责:**
- 订阅 Redis `stream-tasks` channel，接收 Laravel 分发的任务
- 向 apisvr / aistudio（Dify）发起流式 API 调用
- 通过 SSE 端点将 token 实时推送到浏览器
- 任务完成后 POST 结算回调到 Laravel 内部接口

**不负责:** 鉴权、租户隔离、积分扣减、Task 创建 — 这些全部由 backend 处理。

## 📚 跨项目知识库

重要架构决策、技术约定、待办需求统一维护在 `mtai_core/kb/`：

| 文件 | 内容 |
|------|------|
| `kb/architecture.md` | 架构决策记录（ADR）—— 仓库职责、外部服务定位、执行链路 |
| `kb/tech-stack.md` | 各项目技术栈版本、关键约定、服务间接口规范 |
| `kb/backlog.md` | 待办需求与优先级 |

**生成代码前，请先参考以上文档确保与平台架构一致。**

## ⚠️ 重要提示

**禁止创建过程性文档:**
- ❌ 不要创建 BUG 修复报告、清理报告、变更日志等过程性文档
- ✅ 直接修改代码和必要的技术文档
- ✅ 在 Git commit 中记录修改内容

### ⚠️ Stream 路径与 Backend 双路径参数同步

mtai_stream 的 `POST /api/conversations` 路由调用 backend `InternalTaskController::init()` 获取 AI 调用参数。Backend 同时存在另一条路径（`ConversationController` → `ProcessAiTask` Job）用于 workflow 模式。

**两条路径支持的参数必须保持一致：**

| 路径 | 触发方式 | 适用模式 |
|------|---------|----------|
| **Stream** | 前端 → mtai_stream → `InternalTaskController::init()` | chat |
| **Poll** | 前端 → `ConversationController` → Job | workflow / completion |

当 stream 端需要传递新的 AI 参数（如 model、enable_thinking、temperature 等）时，必须同时确认：
1. stream 在 `conversations.ts` 中将参数传给 backend init API
2. backend `InternalTaskController::init()` 接受并返回该参数
3. backend `ConversationController` 的 poll 路径也支持相同参数

**历史教训（2026-04-05）：** backend `ConversationController` 已添加 model/enable_thinking 支持，但 `InternalTaskController::init()` 遗漏，导致 chat 模式下模型选择和思维链功能完全失效。

## 📋 核心规范

### 1. TypeScript 编译配置

```json
{
  "module": "CommonJS",
  "moduleResolution": "Node",
  "target": "ES2022",
  "strict": true
}
```

**关键约束:**
- ❌ 不要使用 `import ... from './foo.js'`（CommonJS 模式不需要 `.js` 后缀）
- ✅ `import { config } from './config'`
- ❌ 不要使用顶层 `await`（CommonJS 不支持）
- ✅ 用 `async function bootstrap()` 包装启动逻辑
- ❌ 不要使用 ESM-only 的语法（`import.meta.url` 等）

### 2. 项目结构

```
src/
├── index.ts              # 入口：启动 Fastify + Redis
├── config.ts             # 环境变量读取（类型安全）
├── redis/
│   └── subscriber.ts     # Redis 订阅 stream-tasks channel
├── tasks/
│   └── manager.ts        # 内存任务状态（EventEmitter per task）
├── routes/
│   └── sse.ts            # GET /sse/:task_id — SSE 端点
├── upstream/
│   └── apisvr.ts         # apisvr stream 调用（OpenAI 兼容 SSE）
└── settle.ts             # 回调 Laravel + 获取 stream-config
```

**目录职责清晰，新增模块按以下规则放置:**
- `upstream/` — 上游 AI 供应商的流式调用适配器（每个供应商一个文件）
- `routes/` — Fastify 路由注册
- `tasks/` — 任务生命周期管理
- `redis/` — Redis 连接和订阅

### 3. 配置管理

所有环境变量通过 `src/config.ts` 统一访问：

```typescript
// ✅ 正确：通过 config 对象读取
import { config } from './config'
const port = config.port

// ❌ 错误：散落的 process.env 读取
const port = process.env.PORT
```

必需的环境变量使用 `requireEnv()` 校验（启动时立即报错，不留隐患）。

### 4. 与 Laravel Backend 的通信

**mtai_stream 是 backend 的工具层，不是对等服务。** 通信规则：

1. **stream → backend（回调）:** 携带 `X-Internal-Token` 头
   - `POST /api/internal/tasks/{id}/settle` — 结算
   - `GET /api/internal/tasks/{id}/stream-config` — 获取调用配置

2. **backend → stream（触发）:** Redis publish `stream-tasks` channel

3. **browser → stream（消费）:** `GET /sse/:task_id`，Bearer token 由 stream 代验（调 backend `/api/v1/user`）

```typescript
// ✅ 正确：内部调用统一携带 token
const headers = { 'X-Internal-Token': config.laravel.internalToken() }

// ❌ 错误：直接操作 backend 数据库
// stream 不连 MySQL，所有持久化操作通过 backend API
```

### 5. SSE 事件格式

```typescript
interface SseEvent {
  event: string    // 'token' | 'done' | 'error'
  data: string     // JSON 字符串
}

// token 事件
{ event: 'token', data: JSON.stringify({ content: '你' }) }

// done 事件
{ event: 'done', data: JSON.stringify({ output: '完整回答...' }) }

// error 事件
{ event: 'error', data: JSON.stringify({ message: '上游超时' }) }
```

### 6. 任务生命周期

1. Laravel `publishTaskCreated()` → Redis `stream-tasks` channel
2. stream 订阅收到消息 → `taskManager.create(taskId)` 创建内存状态
3. stream 调 `fetchStreamConfig(taskId)` 获取调用参数
4. stream 连接上游（apisvr/dify）开始接收 token → 存入 buffer + emit
5. 浏览器连接 `GET /sse/:task_id` → 先发送 buffer 中的历史数据，再实时转发
6. 上游完成 → `settleTask(taskId, payload)` 回调 backend
7. `taskManager.finish(taskId)` → 自动清理

### 7. 命名规范

**文件和目录:** kebab-case
```
src/upstream/apisvr.ts     ✅
src/upstream/ApiSvr.ts     ❌
```

**变量和函数:** camelCase
```typescript
const taskId = 123           // ✅
const task_id = 123          // ❌
function fetchStreamConfig() // ✅
function fetch_stream_config // ❌
```

**类型和接口:** PascalCase
```typescript
interface SseEvent {}    // ✅
interface sseEvent {}    // ❌
type TaskState = {}      // ✅
```

**常量:** camelCase（跟随 Node.js 社区惯例）
```typescript
const defaultTimeout = 120000  // ✅
const DEFAULT_TIMEOUT = 120000 // ❌（除非是真正全局不变的魔法值）
```

### 8. 错误处理

```typescript
// ✅ 上游调用失败时，向 SSE 客户端发送 error 事件，向 backend 发送结算
try {
  await streamFromApisvr(taskId)
} catch (err) {
  taskManager.emit(taskId, { event: 'error', data: JSON.stringify({ message: '上游调用失败' }) })
  taskManager.finish(taskId)
}

// ❌ 错误：静默吞掉错误
try {
  await streamFromApisvr(taskId)
} catch {}
```

### 9. 安全规范

- **SSE 端点鉴权:** Bearer token 必须验证（通过 backend `/api/v1/user`），不可跳过
- **内部回调:** `X-Internal-Token` 必须匹配 `config.laravel.internalToken()`
- **上游 API Key:** 只从 backend `stream-config` 接口获取，不在 stream 端持久化
- **Nginx:** 生产环境 SSE 端点需要设置 `X-Accel-Buffering: no`

### 10. 依赖管理

当前核心依赖：
- `fastify` ^5 — HTTP 框架
- `ioredis` ^5 — Redis 客户端
- `tsx` — 开发时热重载（devDependency）
- `typescript` ^5 — 编译器（devDependency）

**原则:** 尽量少引入依赖。SSE 解析、HTTP 请求用 Node.js 内置能力（`fetch`、手动解析 `text/event-stream`），不引入额外库。

### 11. 错误的模式（避免）

```typescript
// ❌ 在 stream 中做鉴权决策
if (user.role === 'tenant_admin') { ... }

// ❌ 在 stream 中直接连 MySQL
import mysql from 'mysql2'

// ❌ 使用 .js 后缀导入
import { config } from './config.js'

// ❌ 顶层 await
await startRedisSubscriber()

// ❌ 硬编码 URL
const url = 'http://127.0.0.1:80/api/internal/...'
```

### 12. 正确的模式（推荐）

```typescript
// ✅ 所有配置通过 config 读取
const baseUrl = config.laravel.baseUrl

// ✅ 用 async bootstrap 包装启动
async function bootstrap(): Promise<void> {
  startRedisSubscriber()
  await app.listen({ port: config.port, host: '0.0.0.0' })
}
bootstrap().catch((err) => {
  console.error('[mtai-stream] 启动失败:', err)
  process.exit(1)
})

// ✅ EventEmitter 驱动 SSE 推送
taskManager.on(taskId, (event: SseEvent) => {
  reply.raw.write(`event: ${event.event}\ndata: ${event.data}\n\n`)
})
```

## 🔗 相关项目

| 项目 | 关系 |
|------|------|
| `mtai_backend` | stream 的调用方和回调接收方（Laravel） |
| `mtai_front` | SSE 的消费方（浏览器 EventSource） |
| `mtai_core` | 运维配置和知识库 |
| `aistudio` | 上游 AI 供应商之一（Dify） |
| `apisvr` | 上游 AI 供应商之一（OpenAI 兼容接口） |
