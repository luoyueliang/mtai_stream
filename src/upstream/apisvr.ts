import type { StreamInitResult } from '../backend'
import { settleTask, memoryPostProcess } from '../backend'

interface OpenAiChunk {
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

type WriteSse = (event: string, data: Record<string, unknown>) => boolean

/**
 * 将 memory_context 注入到 messages 的 system message 中。
 *
 * - 如果已有 system message，将 memory_context 追加到末尾（换行分隔）
 * - 如果没有 system message，在 messages 开头插入一条
 * - 如果 memory_context 为空，原样返回
 */
function injectMemoryContext(
  messages: Array<{ role: string; content: string }>,
  memoryContext: string | null | undefined,
): Array<{ role: string; content: string }> {
  if (!memoryContext) return messages

  const result = messages.map((m) => ({ ...m }))
  const systemIdx = result.findIndex((m) => m.role === 'system')

  if (systemIdx >= 0) {
    result[systemIdx].content = result[systemIdx].content + '\n\n' + memoryContext
  } else {
    result.unshift({ role: 'system', content: memoryContext })
  }

  return result
}

/**
 * 调用 apisvr（OpenAI 兼容 API），消费 SSE 流，
 * 通过 writeSse 回调实时推送给浏览器。
 *
 * 完成后：发送 done 事件 + 异步调 settle 回调 Backend。
 */
export async function streamFromApisvr(
  init: StreamInitResult,
  writeSse: WriteSse,
): Promise<void> {
  const { task_id, base_url, api_key, model, messages, temperature, max_tokens, enable_thinking, memory_context } = init

  // ── Memory 注入：将 memory_context 合并到 system message ──────────────
  const finalMessages = injectMemoryContext(messages, memory_context)

  // 兼容 base_url 是否以 /v1 结尾的情况
  const endpoint = base_url.endsWith('/v1')
    ? `${base_url}/chat/completions`
    : `${base_url}/v1/chat/completions`

  const body: Record<string, unknown> = {
    model,
    messages: finalMessages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (temperature !== null) body.temperature = temperature
  if (max_tokens !== null) body.max_tokens = max_tokens
  if (enable_thinking) body.enable_thinking = true

  const res = await fetch(endpoint, {
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

  let accumulatedText = ''
  let accumulatedThinking = ''
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  const startMs = Date.now()

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  try {
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

        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? promptTokens
          completionTokens = chunk.usage.completion_tokens ?? completionTokens
          totalTokens = chunk.usage.total_tokens ?? totalTokens
        }

        const reasoning = chunk.choices?.[0]?.delta?.reasoning_content
        if (reasoning) {
          accumulatedThinking += reasoning
          // 推理内容包裹在 <think> 标签中，前端 parseOutputFull 会解析
          if (!writeSse('token', { content: reasoning, task_id, reasoning: true })) {
            // 浏览器已断开，但继续消费完上游流以便 settle
          }
        }

        const content = chunk.choices?.[0]?.delta?.content
        if (content) {
          accumulatedText += content
          if (!writeSse('token', { content, task_id })) {
            // 浏览器已断开，但继续消费完上游流以便 settle
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  const executionTimeMs = Date.now() - startMs

  writeSse('done', { task_id, total_tokens: totalTokens, execution_time_ms: executionTimeMs })

  // settle 异步执行，不阻塞 SSE 响应关闭
  const fullOutput = accumulatedThinking
    ? `<think>${accumulatedThinking}</think>${accumulatedText}`
    : accumulatedText
  settleTask(task_id, {
    output: fullOutput,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  })
    .then(() => {
      // settle 成功后触发 Memory 后处理（显式记忆检测 + 摘要 + 隐式提取）
      memoryPostProcess(task_id).catch((err) => {
        console.error(`[memory] task ${task_id} 后处理失败:`, err)
      })
    })
    .catch((err) => {
      console.error(`[settle] task ${task_id} 结算失败:`, err)
    })
}
