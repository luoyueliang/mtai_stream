import { EventEmitter } from 'node:events'

/**
 * 每个任务的运行时状态
 */
export interface TaskState {
  /** Laravel task_id */
  taskId: number
  /** 任务归属用户 ID（用于 SSE 鉴权） */
  userId: number
  /** 已缓冲的 SSE 事件（浏览器连接前产生的事件） */
  buffer: SseEvent[]
  /** 事件发射器：浏览器连接后监听 'event' */
  emitter: EventEmitter
  /** 是否已结束（done 或 error） */
  finished: boolean
  /** 超时定时器 handle */
  timer: ReturnType<typeof setTimeout> | null
}

export interface SseEvent {
  type: 'token' | 'node_progress' | 'done' | 'error'
  data: Record<string, unknown>
}

/**
 * 内存任务管理器
 *
 * 生命周期：
 *   create() → emit*() → finish() → [browser drain buffer + live stream] → destroy()
 *
 * 为什么用内存：流式 token 内容不持久化，最终 output 在 settle 时写入 tasks 表。
 * 重启后未完成任务自然超时，Queue Worker 的 ProcessAiTask Job 会继续执行并通过
 * 轮询路径完成（向后兼容）。
 */
class TaskManager {
  private tasks = new Map<number, TaskState>()

  create(taskId: number, userId: number, timeoutMs: number): TaskState {
    const state: TaskState = {
      taskId,
      userId,
      buffer: [],
      emitter: new EventEmitter(),
      finished: false,
      timer: null,
    }

    state.timer = setTimeout(() => {
      this.emit(taskId, {
        type: 'error',
        data: { task_id: taskId, message: '任务超时，请刷新页面后重试' },
      })
      this.finish(taskId)
    }, timeoutMs)

    this.tasks.set(taskId, state)
    return state
  }

  get(taskId: number): TaskState | undefined {
    return this.tasks.get(taskId)
  }

  /**
   * 发射 SSE 事件：缓冲 + 通知已连接的浏览器
   */
  emit(taskId: number, event: SseEvent): void {
    const state = this.tasks.get(taskId)
    if (!state || state.finished) return
    state.buffer.push(event)
    state.emitter.emit('event', event)
  }

  /**
   * 标记任务结束，清理定时器（不立即从 Map 删除，等浏览器断开后 destroy）
   */
  finish(taskId: number): void {
    const state = this.tasks.get(taskId)
    if (!state) return
    state.finished = true
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
  }

  /**
   * 从内存中移除任务（浏览器 SSE 连接关闭后调用）
   */
  destroy(taskId: number): void {
    const state = this.tasks.get(taskId)
    if (state) {
      state.emitter.removeAllListeners()
      if (state.timer) clearTimeout(state.timer)
    }
    this.tasks.delete(taskId)
  }
}

export const taskManager = new TaskManager()
