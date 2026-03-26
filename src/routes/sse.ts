import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { taskManager } from '../tasks/manager'
import { validateBearerToken } from '../settle'

/**
 * SSE 端点：GET /sse/:task_id
 *
 * 浏览器连接后：
 *   1. 验证 Authorization: Bearer token（调用 Laravel /api/v1/user）
 *   2. 检查 task 归属（token 对应的 user_id 必须与 task.userId 一致）
 *   3. 先发送缓冲事件（Node.js 先于浏览器连接时积累的 token）
 *   4. 然后实时转发后续事件，直到 done/error
 *
 * SSE 事件格式（与 ADR-004 约定一致）：
 *   event: token\ndata: {...}\n\n
 *   event: done\ndata: {...}\n\n
 *   event: error\ndata: {...}\n\n
 */
export async function registerSseRoutes(app: FastifyInstance): Promise<void> {
  app.get('/sse/:task_id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { task_id } = request.params as { task_id: string }
    const taskId = parseInt(task_id, 10)

    if (isNaN(taskId) || taskId <= 0) {
      return reply.status(400).send({ message: '无效的 task_id' })
    }

    // ── 鉴权 ──────────────────────────────────────────────────────────────
    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ message: '缺少 Authorization 头' })
    }

    const userId = await validateBearerToken(authHeader)
    if (!userId) {
      return reply.status(401).send({ message: 'Token 无效或已过期' })
    }

    // ── 任务归属校验 ────────────────────────────────────────────────────────
    const state = taskManager.get(taskId)
    if (!state) {
      // 任务不在内存中：可能已完成销毁，或 Node.js 重启后遗失
      return reply.status(404).send({ message: '任务不存在或已过期，请使用轮询接口获取结果' })
    }

    if (state.userId !== userId) {
      return reply.status(403).send({ message: '无权访问此任务' })
    }

    // ── 建立 SSE 流 ─────────────────────────────────────────────────────────
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // 关闭 Nginx 缓冲
    })

    const writeSse = (event: string, data: Record<string, unknown>): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    // 发送心跳（保持连接）
    reply.raw.write(': connected\n\n')

    // ── 发送缓冲事件 ────────────────────────────────────────────────────────
    for (const buffered of state.buffer) {
      writeSse(buffered.type, buffered.data)
    }

    // 任务已完成时直接关闭连接
    if (state.finished) {
      reply.raw.end()
      taskManager.destroy(taskId)
      return
    }

    // ── 实时监听后续事件 ────────────────────────────────────────────────────
    const onEvent = (event: { type: string; data: Record<string, unknown> }): void => {
      writeSse(event.type, event.data)

      if (event.type === 'done' || event.type === 'error') {
        reply.raw.end()
        state.emitter.off('event', onEvent)
        taskManager.destroy(taskId)
      }
    }

    state.emitter.on('event', onEvent)

    // 浏览器断开时清理
    request.raw.on('close', () => {
      state.emitter.off('event', onEvent)
    })
  })
}
