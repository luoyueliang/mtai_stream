/**
 * 环境变量配置（类型安全读取）
 *
 * 所有模块通过此文件访问 env，避免散落的 process.env 读取。
 */

function requireEnv(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`环境变量 ${key} 未配置`)
  return val
}

export const config = {
  port: parseInt(process.env.PORT ?? '3100', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  redis: {
    url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    db: parseInt(process.env.REDIS_DB ?? '3', 10),
  },

  laravel: {
    baseUrl: process.env.LARAVEL_BASE_URL ?? 'http://127.0.0.1:80',
    internalToken: () => requireEnv('INTERNAL_TOKEN'),
  },

  task: {
    timeoutMs: parseInt(process.env.TASK_TIMEOUT_MS ?? '120000', 10),
  },
} as const
