import { taskManager } from '../tasks/manager'
import { settleTask, fetchStreamConfig } from '../settle'

interface OpenAiChunk {
  choices?: Array<{
    delta?: { content?: string }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/**
 * 调用 apisvr（OpenAI 兼容 API），消费 SSE 流，将 token 实时推送给浏览器
 *
 * 流程：
 *   1. 从 Laravel 拉取任务配置（model、messages、api_key 等）
 *   2. POST {base_url}/chat/completions（stream=true）
 *   3. 逐行解析 `data: {...}` SSE 事件
 *   4. 每个 content delta → emit token 事件到 taskManager
 *   5. 结束时：emit done，调用 settleTask 回调 Laravel
 */
export async function streamFromApisvr(taskId: number): Promise<void> {
  let streamConfig

  try {
    streamConfig = await fetchStreamConfig(taskId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    taskManager.emit(taskId, { type: 'error', data: { task_id: taskId, message } })
    taskManager.finish(taskId)
    return
  }

  const { base_url, api_key, model, messages, temperature, max_tokens, user_id } = streamConfig

  // 确保任务状态已创建（subscriber 应先调用 taskManager.create）
  if (!taskManager.get(taskId)) {
    const { config } = await import('../config')
    taskManager.create(taskId, user_id, config.task.timeoutMs)
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (temperature !== null) body.temperature = temperature
  if (max_tokens !== null) body.max_tokens = max_tokens

  let accumulatedText = ''
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  const startMs = Date.now()

  try {
    const res = await fetch(`${base_url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${api_key}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new Error(`apisvr 返回错误 [${res.status}]: ${text}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buf += decoder.decode(value, { stream: true })

      const lines = buf.split('\n')
      buf = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue

        const jsonStr = trimmed.slice(5).trim()
        if (jsonStr === '[DONE]') continue

        let chunk: OpenAiChunk
        try {
          chunk = JSON.parse(jsonStr) as OpenAiChunk
        } catch {
          continue
        }

        // 收集 usage（通常在最后一个带 finish_reason 的 chunk 或独立 chunk）
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? promptTokens
          completionTokens = chunk.usage.completion_tokens ?? completionTokens
          totalTokens = chunk.usage.total_tokens ?? totalTokens
        }

        const content = chunk.choices?.[0]?.delta?.content
        if (content) {
          accumulatedText += content
          taskManager.emit(taskId, {
            type: 'token',
            data: { content, task_id: taskId },
          })
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    taskManager.emit(taskId, { type: 'error', data: { task_id: taskId, message } })
    taskManager.finish(taskId)
    return
  }

  const executionTimeMs = Date.now() - startMs

  // 推送 done 事件
  taskManager.emit(taskId, {
    type: 'done',
    data: { task_id: taskId, total_tokens: totalTokens, execution_time_ms: executionTimeMs },
  })
  taskManager.finish(taskId)

  // 回调 Laravel 结算
  try {
    await settleTask(taskId, {
      output: accumulatedText,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    })
  } catch (err) {
    console.error(`[settle] task ${taskId} 结算失败:`, err)
  }
}
