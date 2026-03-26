import { config } from './config'

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
 * 流式完成后回调 Laravel 结算接口
 *
 * POST /api/internal/tasks/{task_id}/settle
 * X-Internal-Token: {INTERNAL_TOKEN}
 */
export async function settleTask(taskId: number, payload: SettlePayload): Promise<void> {
  const url = `${config.laravel.baseUrl}/api/internal/tasks/${taskId}/settle`
  const token = config.laravel.internalToken()

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': token,
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`settle 回调失败 [${res.status}]: ${body}`)
  }
}

/**
 * 从 Laravel 获取任务流式调用配置
 *
 * GET /api/internal/tasks/{task_id}/stream-config
 */
export interface StreamConfig {
  task_id: number
  user_id: number
  provider: string
  base_url: string
  api_key: string
  model: string
  messages: Array<{ role: string; content: string }>
  temperature: number | null
  max_tokens: number | null
}

export async function fetchStreamConfig(taskId: number): Promise<StreamConfig> {
  const url = `${config.laravel.baseUrl}/api/internal/tasks/${taskId}/stream-config`
  const token = config.laravel.internalToken()

  const res = await fetch(url, {
    headers: { 'X-Internal-Token': token },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`获取 stream-config 失败 [${res.status}]: ${body}`)
  }

  const json = (await res.json()) as { success: boolean } & StreamConfig
  if (!json.success) throw new Error('stream-config 返回 success=false')

  return json
}

/**
 * 用浏览器的 Bearer token 调用 Laravel /api/v1/user，验证其有效性并返回 user_id
 *
 * 返回 null 表示 token 无效或网络错误。
 */
export async function validateBearerToken(bearerToken: string): Promise<number | null> {
  const url = `${config.laravel.baseUrl}/api/v1/user`

  try {
    const res = await fetch(url, {
      headers: { Authorization: bearerToken },
    })
    if (!res.ok) return null

    const json = (await res.json()) as { data?: { user_id?: number } }
    return json.data?.user_id ?? null
  } catch {
    return null
  }
}
