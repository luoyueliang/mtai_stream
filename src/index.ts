import Fastify from 'fastify'
import { config } from './config'
import { startRedisSubscriber } from './redis/subscriber'
import { registerSseRoutes } from './routes/sse'

const app = Fastify({
  logger: {
    level: config.nodeEnv === 'production' ? 'info' : 'debug',
  },
})

// ── 健康检查 ────────────────────────────────────────────────────────────────
app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }))

// ── 启动 ─────────────────────────────────────────────────────────────────────
async function bootstrap(): Promise<void> {
  // SSE 路由注册
  await registerSseRoutes(app)

  // 先启动 Redis 订阅（在 HTTP 服务就绪前开始监听，避免错过早到的任务消息）
  startRedisSubscriber()

  await app.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`[mtai-stream] 流式代理服务已启动，端口 ${config.port}`)
}

bootstrap().catch((err) => {
  console.error('[mtai-stream] 启动失败:', err)
  process.exit(1)
})
