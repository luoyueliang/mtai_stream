import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import Redis from 'ioredis'
import { config } from '../config'

/**
 * GET /api/tasks/subscribe?token=xxx — SSE 任务状态订阅
 *
 * 流程：
 *   1. 从 query 取 token，调 Backend /api/internal/auth/verify 校验，拿到 user_id
 *   2. 建立 SSE 长连接
 *   3. 订阅 Redis task-status channel，按 user_id 过滤后推送给浏览器
 *   4. 客户端断开时退订
 */
export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tasks/subscribe', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = (request.query as Record<string, string>).token
    if (!token) {
      return reply.status(400).send({ message: '缺少 token 参数' })
    }

    // ── 验证 token ──────────────────────────────────────────────────────
    let userId: number
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Internal-Token': config.laravel.internalToken(),
      }
      if (config.laravel.host) headers['Host'] = config.laravel.host

      const authRes = await fetch(`${config.laravel.baseUrl}/api/internal/auth/verify`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ token }),
      })

      if (!authRes.ok) {
        const status = authRes.status === 401 ? 401 : 403
        return reply.status(status).send({ message: 'Token 验证失败' })
      }

      const data = (await authRes.json()) as { user_id?: number | string }
      if (!data.user_id) {
        return reply.status(401).send({ message: 'Token 无效' })
      }

      userId = Number(data.user_id)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Auth verification failed'
      return reply.status(502).send({ message })
    }

    // ── 建立 SSE 流 ──────────────────────────────────────────────────────
    reply.hijack()

    const corsHeaders: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    }
    const origin = request.headers.origin
    if (origin) {
      const allowed = config.cors.origin.split(',').map((s) => s.trim())
      if (allowed.includes(origin)) {
        corsHeaders['Access-Control-Allow-Origin'] = origin
      }
    }

    reply.raw.writeHead(200, corsHeaders)

    const writeSse = (event: string, data: Record<string, unknown>): boolean => {
      if (reply.raw.destroyed) return false
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      return true
    }

    writeSse('connected', { user_id: userId })

    // ── Redis 订阅 ──────────────────────────────────────────────────────
    const subscriber = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password === 'null' ? undefined : config.redis.password,
      retryStrategy(times: number) {
        return Math.min(times * 200, 5000)
      },
    })

    subscriber.subscribe('task-status', (err) => {
      if (err) {
        app.log.error(`[task-subscribe] Redis subscribe failed: ${err.message}`)
        writeSse('error', { message: 'Redis 订阅失败' })
        if (!reply.raw.destroyed) reply.raw.end()
        subscriber.disconnect()
        return
      }
      app.log.info(`[task-subscribe] User ${userId} subscribed to task-status`)
    })

    subscriber.on('message', (_channel: string, message: string) => {
      try {
        const data = JSON.parse(message) as { user_id?: number; task_id?: number; type?: string; status?: string; title?: string }
        // 只推送属于当前用户的任务状态（需类型转换：auth/verify 可能返回 string）
        if (Number(data.user_id) !== userId) return

        // title_generated 事件（异步标题生成完成）
        if (data.type === 'title_generated') {
          writeSse('title_generated', {
            task_id: data.task_id,
            title: data.title ?? '',
          })
          return
        }

        // task_progress 事件（中间进度：partial_output / 节点状态）
        if (data.type === 'task_progress') {
          const payload: Record<string, unknown> = {
            task_id: data.task_id,
            status: (data as Record<string, unknown>).status,
          }
          if ((data as Record<string, unknown>).partial_output !== undefined) {
            payload.partial_output = (data as Record<string, unknown>).partial_output
          }
          if ((data as Record<string, unknown>).nodes !== undefined) {
            payload.nodes = (data as Record<string, unknown>).nodes
          }
          writeSse('task_progress', payload)
          return
        }

        // task_status 事件（任务状态变更）
        writeSse('task_status', {
          task_id: data.task_id,
          status: (data as Record<string, unknown>).status,
          title: (data as Record<string, unknown>).title ?? null,
          output: (data as Record<string, unknown>).output ?? null,
          credits_used: (data as Record<string, unknown>).credits_used ?? 0,
          completed_at: (data as Record<string, unknown>).completed_at ?? null,
        })
      } catch {
        // ignore parse errors
      }
    })

    // ── 心跳保活 ─────────────────────────────────────────────────────────
    const heartbeat = setInterval(() => {
      if (reply.raw.destroyed) {
        clearInterval(heartbeat)
        return
      }
      reply.raw.write(':heartbeat\n\n')
    }, 30000)

    // ── 客户端断开 → 清理 ────────────────────────────────────────────────
    request.raw.on('close', () => {
      clearInterval(heartbeat)
      subscriber.unsubscribe('task-status')
      subscriber.disconnect()
      app.log.info(`[task-subscribe] User ${userId} disconnected`)
    })
  })
}
