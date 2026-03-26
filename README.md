# mtai_stream — 流式代理中间层

SSE 流式代理中间层，位于 backend 与 AI 供应商（dify/apisvr）之间。

## 架构职责

- 订阅 Redis `stream-tasks` channel，接收 Laravel 分发的任务
- 向 apisvr (Phase 2) 或 aistudio/Dify (Phase 4) 发起流式 API 调用
- 通过 SSE 端点将 token 实时推送到浏览器
- 任务完成后 POST 结算回调到 Laravel 内部接口

参考 `mtai_core/kb/architecture.md` ADR-004 了解完整接口约定。

## 快速开始

```bash
cp .env.example .env
# 编辑 .env 填写配置
npm install
npm run dev       # 开发模式（热重载）
npm run build     # 构建生产版本
npm run start     # 运行生产版本
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口 | `3100` |
| `REDIS_URL` | Redis 连接地址 | `redis://127.0.0.1:6379` |
| `REDIS_DB` | Redis 数据库编号 | `3` |
| `LARAVEL_BASE_URL` | mtai_backend 内网地址 | `http://127.0.0.1:80` |
| `INTERNAL_TOKEN` | 与 Laravel STREAM_SERVICE_SECRET 一致 | — |
| `TASK_TIMEOUT_MS` | 单个任务最长等待（毫秒） | `120000` |

## 项目结构

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
└── settle.ts             # POST /api/internal/tasks/{id}/settle 回调
```

## 生产部署

```bash
# 构建
npm run build

# 启动（使用 PM2 管理进程）
pm2 start dist/index.js --name mtai-stream

# 宿主机 Nginx 代理（stream.ai.mtedu.com → 127.0.0.1:3100）
# 配置见 mtai_core/nginx-config/
```
