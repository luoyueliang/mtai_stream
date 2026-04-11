import { config } from './config'

/** 构建 Backend 请求 headers，生产环境注入 Host 头确保 Nginx 路由正确 */
function backendHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Internal-Token': config.laravel.internalToken(),
    ...extra,
  }
  if (config.laravel.host) h['Host'] = config.laravel.host
  return h
}

/** Backend init 接口返回的完整 AI 调用配置 */
export interface StreamInitResult {
  task_id: number
  conversation_id: number
  user_id: number
  tenant_id: number
  provider: string
  base_url: string
  api_key: string
  model: string
  messages: Array<{ role: string; content: string }>
  temperature: number | null
  max_tokens: number | null
  enable_thinking: boolean
}

/**
 * 调用 Backend POST /api/internal/stream/init
 *
 * 透传用户 Bearer token + X-Internal-Token，Backend 完成：
 * 鉴权 → tenant 解析 → credit 预检 → 创建 Task → 返回完整 AI 调用配置
 *
 * 失败时抛出带 statusCode 的 Error（401/402/404/500），由路由层转发给浏览器。
 */
export async function initStream(
  bearerToken: string | undefined,
  body: { agent_id: number; message: string; conversation_id?: number; model?: string; enable_thinking?: boolean },
  extraHeaders?: Record<string, string>,
): Promise<StreamInitResult> {
  const url = `${config.laravel.baseUrl}/api/internal/stream/init`

  const extra: Record<string, string> = { ...extraHeaders }
  if (bearerToken) extra['Authorization'] = bearerToken

  const res = await fetch(url, {
    method: 'POST',
    headers: backendHeaders(extra),
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    // 尝试解析 JSON 以保留 error_code 等结构化字段
    let parsed: Record<string, unknown> | null = null
    try { parsed = JSON.parse(text) } catch { /* 非 JSON，忽略 */ }
    const message = (parsed?.message as string) || text || `Backend init 失败 [${res.status}]`
    const err = new Error(message) as Error & {
      statusCode: number
      errorBody: Record<string, unknown> | null
    }
    err.statusCode = res.status
    err.errorBody = parsed
    throw err
  }

  const json = (await res.json()) as { success: boolean } & StreamInitResult
  if (!json.success) throw new Error('Backend init 返回 success=false')

  return json
}

// ── Settle ──────────────────────────────────────────────────────────────────

export interface SettlePayload {
  output: string
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  dify_conversation_id?: string | null
  dify_message_id?: string | null
  dify_task_id?: string | null
  dify_workflow_run_id?: string | null
  dify_outputs?: Record<string, unknown> | null
}

/**
 * 流式完成后回调 Backend 结算接口
 *
 * POST /api/internal/tasks/{task_id}/settle
 */
export async function settleTask(taskId: number, payload: SettlePayload): Promise<void> {
  const url = `${config.laravel.baseUrl}/api/internal/tasks/${taskId}/settle`

  const res = await fetch(url, {
    method: 'POST',
    headers: backendHeaders(),
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`settle 回调失败 [${res.status}]: ${body}`)
  }
}
