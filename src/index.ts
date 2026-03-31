import 'dotenv/config'
import Fastify from 'fastify'
import { config } from './config'
import { registerConversationRoutes } from './routes/conversations'
import { registerTaskRoutes } from './routes/tasks'

const app = Fastify({
  logger: {
    level: config.nodeEnv === 'production' ? 'info' : 'debug',
  },
})

// ── CORS（ai.mtedu.com → stream.ai.mtedu.com 跨域） ────────────────────────
app.addHook('onRequest', (request, reply, done) => {
  const origin = request.headers.origin
  if (origin) {
    const allowed = config.cors.origin.split(',').map((s) => s.trim())
    if (allowed.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin)
    }
    reply.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    reply.header('Access-Control-Max-Age', '86400')
  }
  if (request.method === 'OPTIONS') {
    reply.status(204).send()
    return
  }
  done()
})

// ── 健康检查 ────────────────────────────────────────────────────────────────
app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }))

// ── 启动 ─────────────────────────────────────────────────────────────────────
async function bootstrap(): Promise<void> {
  await registerConversationRoutes(app)
  await registerTaskRoutes(app)

  await app.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`[mtai-stream] v2 流式代理已启动，端口 ${config.port}`)
}

bootstrap().catch((err) => {
  console.error('[mtai-stream] 启动失败:', err)
  process.exit(1)
})
