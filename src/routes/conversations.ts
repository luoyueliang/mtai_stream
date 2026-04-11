import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { initStream } from '../backend'
import { streamFromApisvr } from '../upstream/apisvr'
import { config } from '../config'

interface ConversationBody {
  agent_id: number
  message: string
  conversation_id?: number
  model?: string
  enable_thinking?: boolean
}

/**
 * POST /api/conversations — 浏览器直连入口
 *
 * 一次请求完成全部流式流程：
 *   1. 透传 Bearer token 调 Backend init（鉴权 + 创建 Task + 返回 AI 配置）
 *   2. 建立 SSE 流，发送 connected 事件
 *   3. 调用 AI 上游（apisvr），逐 token 推送给浏览器
 *   4. 完成后调 settle 结算，发送 done 事件，关闭连接
 */
export async function registerConversationRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/conversations', async (request: FastifyRequest, reply: FastifyReply) => {
    // ── 参数校验 ──────────────────────────────────────────────────────────
    const authHeader = request.headers.authorization as string | undefined
    const sessionToken = request.headers['x-session-token'] as string | undefined

    // 无 Authorization 且无 X-Session-Token → 401
    if (!authHeader && !sessionToken) {
      return reply.status(401).send({ message: '缺少 Authorization 或 X-Session-Token' })
    }

    const body = request.body as ConversationBody | null
    if (!body?.agent_id || !body?.message) {
      return reply.status(400).send({ message: '缺少 agent_id 或 message' })
    }

    // ── 调 Backend init（鉴权 + 创建 Task + 返回 AI 调用配置）──────────────
    // 透传前端 X-Tenant-ID / X-Session-Token，让 Backend 正确识别租户和会话上下文
    const forwardHeaders: Record<string, string> = {}
    const tenantId = request.headers['x-tenant-id']
    if (typeof tenantId === 'string') forwardHeaders['X-Tenant-ID'] = tenantId
    if (sessionToken) forwardHeaders['X-Session-Token'] = sessionToken

    let initResult
    try {
      initResult = await initStream(authHeader, {
        agent_id: body.agent_id,
        message: body.message,
        conversation_id: body.conversation_id,
        model: body.model,
        enable_thinking: body.enable_thinking,
      }, forwardHeaders)
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 502
      const message = err instanceof Error ? err.message : 'Backend 初始化失败'
      const errorBody = (err as { errorBody?: Record<string, unknown> }).errorBody
      // 透传 Backend JSON 结构（含 error_code 等字段），无结构化时回退纯 message
      return reply.status(status).send(errorBody ?? { message })
    }

    // ── 建立 SSE 流 ──────────────────────────────────────────────────────
    reply.hijack()

    // hijack 后 Fastify 不再写响应，需手动带上 CORS 头
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

    writeSse('connected', {
      task_id: initResult.task_id,
      conversation_id: initResult.conversation_id,
    })

    // ── 超时保护 ─────────────────────────────────────────────────────────
    const timeout = setTimeout(() => {
      writeSse('error', {
        task_id: initResult.task_id,
        message: '任务超时，请重试',
      })
      if (!reply.raw.destroyed) reply.raw.end()
    }, config.task.timeoutMs)

    // ── 调 AI 上游流式 ──────────────────────────────────────────────────
    try {
      if (initResult.provider === 'openai' || initResult.provider === 'apisvr') {
        await streamFromApisvr(initResult, writeSse)
      } else {
        // TODO Phase 6: Dify provider
        writeSse('error', {
          task_id: initResult.task_id,
          message: `暂不支持 provider: ${initResult.provider}`,
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      writeSse('error', { task_id: initResult.task_id, message })
    }

    clearTimeout(timeout)
    if (!reply.raw.destroyed) reply.raw.end()
  })
}
