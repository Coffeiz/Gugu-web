import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import type { FastifyRequest } from 'fastify'

export interface RateLimitOptions {
  readonly bucket: string
  readonly limit: number
  readonly windowSeconds: number
  readonly extra?: string
  readonly deviceLimit?: number
  readonly deviceWindowSeconds?: number
  readonly failClosed?: boolean
}

export interface RedisRateLimitCommands {
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
}

export type RateLimitHandler = (request: FastifyRequest, options: RateLimitOptions) => Promise<void>

export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly statusCode: 429 | 503,
  ) {
    super(message)
    this.name = 'RateLimitError'
  }
}

const tooManyRequests = '操作过于频繁，请稍后再试'
const unavailable = '注册服务暂不可用，请稍后重试'
const deviceIdPattern = /^[A-Za-z0-9_-]{16,128}$/

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function clientIp(request: FastifyRequest): string {
  const forwardedFor = request.headers['x-forwarded-for']
  if (typeof forwardedFor === 'string') {
    const candidates = forwardedFor.split(',').map((part) => part.trim()).filter(Boolean)
    const appendedPeer = candidates.at(-1)
    if (appendedPeer && isIP(appendedPeer)) return appendedPeer
  }

  const peer = request.raw.socket.remoteAddress
  return peer && isIP(peer) ? peer : 'unknown'
}

function keyFor(bucket: string, kind: 'ip' | 'device', identity: string, extra: string): string {
  const extraPart = extra ? `:${sha256(extra).slice(0, 24)}` : ''
  return `rl:${bucket}:${kind}:${sha256(identity)}${extraPart}`
}

function unavailableError(): RateLimitError {
  return new RateLimitError(unavailable, 503)
}

/**
 * 创建共享 Redis 固定窗口限流器。每个桶首个 INCR 设置一次 TTL；默认 fail-open 与 Python
 * 认证限流一致，只有明确 failClosed 的调用方会在 Redis 缺失或故障时收到 503。
 */
export function createRedisRateLimiter(redis: RedisRateLimitCommands | null): RateLimitHandler {
  return async (request, options) => {
    if (!redis) {
      if (options.failClosed) throw unavailableError()
      return
    }

    const check = async (key: string, maximum: number, ttl: number): Promise<void> => {
      const count = await redis.incr(key)
      if (!Number.isSafeInteger(count) || count < 1)
        throw new Error('Redis rate-limit counter invalid')
      if (count === 1) await redis.expire(key, ttl)
      if (count > maximum) throw new RateLimitError(tooManyRequests, 429)
    }

    try {
      const extra = options.extra ?? ''
      const ip = clientIp(request)
      await check(keyFor(options.bucket, 'ip', ip, extra), options.limit, options.windowSeconds)

      const rawDeviceId = request.headers['x-device-id']
      if (options.deviceLimit !== undefined && typeof rawDeviceId === 'string') {
        const deviceId = rawDeviceId.trim()
        if (deviceIdPattern.test(deviceId)) {
          await check(
            keyFor(options.bucket, 'device', deviceId, extra),
            options.deviceLimit,
            options.deviceWindowSeconds ?? options.windowSeconds,
          )
        }
      }
    } catch (error) {
      if (error instanceof RateLimitError) throw error
      if (options.failClosed) throw unavailableError()
      // 与 Python 默认认证限流一致：Redis 故障不锁死登录流程。
    }
  }
}
