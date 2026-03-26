import Redis from 'ioredis'
import { config } from '../config'
import { taskManager } from '../tasks/manager'
import { streamFromApisvr } from '../upstream/apisvr'

interface TaskMessage {
  task_id: number
  agent_id: number
  tenant_id: number
  user_id: number
  conversation_id: number | null
}

/**
 * Redis 订阅器
 *
 * 监听 stream-tasks channel，每收到一条消息（由 Laravel TaskService 发布）：
 *   1. 解析任务基本信息
 *   2. 在内存中创建任务状态槽
 *   3. 异步发起 upstream 流式调用
 *
 * 注意：ioredis subscriber 实例不能执行普通命令，需单独实例。
 */
export function startRedisSubscriber(): void {
  const sub = new Redis({
    host: extractRedisHost(),
    port: extractRedisPort(),
    db: config.redis.db,
    lazyConnect: false,
  })

  sub.on('error', (err) => {
    console.error('[redis] 连接错误:', err)
  })

  sub.subscribe('stream-tasks', (err, count) => {
    if (err) {
      console.error('[redis] 订阅 stream-tasks 失败:', err)
      return
    }
    console.log(`[redis] 已订阅 stream-tasks，当前订阅数: ${count}`)
  })

  sub.on('message', (_channel: string, message: string) => {
    let parsed: TaskMessage
    try {
      parsed = JSON.parse(message) as TaskMessage
    } catch {
      console.error('[redis] 消息解析失败:', message)
      return
    }

    const { task_id, user_id } = parsed

    if (!task_id || !user_id) {
      console.warn('[redis] 消息缺少 task_id 或 user_id，跳过:', parsed)
      return
    }

    // 创建内存任务槽（浏览器 SSE 连接时会消费）
    taskManager.create(task_id, user_id, config.task.timeoutMs)

    console.log(`[redis] 收到任务 ${task_id}，开始流式处理`)

    // 异步执行，不阻塞 Redis 订阅循环
    streamFromApisvr(task_id).catch((err) => {
      console.error(`[stream] task ${task_id} 流式处理异常:`, err)
    })
  })
}

function extractRedisHost(): string {
  try {
    return new URL(config.redis.url).hostname
  } catch {
    return '127.0.0.1'
  }
}

function extractRedisPort(): number {
  try {
    return parseInt(new URL(config.redis.url).port || '6379', 10)
  } catch {
    return 6379
  }
}
