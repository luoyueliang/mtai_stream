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

  laravel: {
    baseUrl: process.env.LARAVEL_BASE_URL ?? 'http://127.0.0.1:80',
    /** 生产环境 Nginx 需要正确的 Host 头路由到 Laravel server block */
    host: process.env.LARAVEL_HOST ?? '',
    internalToken: () => requireEnv('INTERNAL_TOKEN'),
  },

  cors: {
    origin: process.env.CORS_ORIGIN ?? 'https://ai.mtedu.com',
  },

  redis: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    /** Laravel Redis prefix — must match config('database.redis.options.prefix') */
    prefix: process.env.REDIS_PREFIX ?? '',
  },

  task: {
    timeoutMs: parseInt(process.env.TASK_TIMEOUT_MS ?? '120000', 10),
  },
} as const
