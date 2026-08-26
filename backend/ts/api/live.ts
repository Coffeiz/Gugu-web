import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createClient } from 'redis'

import { isLiveEventPayload, type LiveEventPayload } from '../packages/contracts/src/live-events.ts'

export const LIVE_API_PORT = Number(process.env.TS_LIVE_PORT ?? 8585)
export const BROADCAST_CHANNEL = 'events:__broadcast__'

type RedisClient = ReturnType<typeof createClient>

function allowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null
  const configured = (process.env.TS_LIVE_ALLOWED_ORIGINS ?? '')
    .split(',').map(value => value.trim()).filter(Boolean)
  if (configured.length === 0) return '*'
  if (configured.includes('*')) return '*'
  return configured.includes(origin) ? origin : null
}

/** 将 Redis 消息转换为 SSE 数据；非法或非业务消息不进入浏览器事件流。 */
export function serializeLiveEvent(raw: string): string | null {
  try {
    const event: unknown = JSON.parse(raw)
    if (isLiveEventPayload(event)) return `data: ${JSON.stringify(event)}\n\n`
    if (event && typeof event === 'object' && 'notification' in event) {
      return `data: ${raw}\n\n`
    }
  } catch {
    // Redis 中的坏消息不能污染 SSE 连接。
  }
  return null
}

function writeCorsHeaders(request: IncomingMessage, response: ServerResponse): void {
  const origin = allowedOrigin(request.headers.origin)
  if (!origin) return
  response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
}

export function liveChannelFor(userId: string): string {
  return `events:${userId}`
}

export function redisUrlFromEnv(): string {
  if (process.env.REDIS_URL) return process.env.REDIS_URL
  const host = process.env.REDIS__HOST ?? '127.0.0.1'
  const port = process.env.REDIS__PORT ?? '6379'
  const password = process.env.REDIS__PASSWORD
  const auth = password ? `:${encodeURIComponent(password)}@` : ''
  return `redis://${auth}${host}:${port}/0`
}

function base64UrlJson(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
}

/** Standalone API 只验证 user JWT，不查询数据库，避免长连接占用数据库连接池。 */
export function authorizeRequest(request: IncomingMessage, secret = process.env.GUGU_SECRET_KEY ?? process.env.SECRET_KEY ?? ''): string | null {
  const header = request.headers.authorization ?? ''
  const match = /^Bearer\s+(.+)$/.exec(header)
  if (!match || !secret) return null
  const token = match[1]
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const [encodedHeader, encodedPayload, signature] = parts
    const headerPayload = base64UrlJson(encodedHeader)
    const payload = base64UrlJson(encodedPayload)
    if (headerPayload.alg !== 'HS256' || payload.role !== 'user' || typeof payload.sub !== 'string') return null
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null
    const expected = createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
    return payload.sub
  } catch {
    return null
  }
}

export function writeSseHeaders(response: ServerResponse, request?: IncomingMessage): void {
  if (request) writeCorsHeaders(request, response)
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
}

function writeComment(response: ServerResponse, value: string): void {
  response.write(`: ${value}\n\n`)
}

/** 每个 HTTP 连接使用一个独立 Redis subscriber，断开时一定 unsubscribe/quit。 */
export async function serveLiveStream(userId: string, response: ServerResponse, redisUrl = redisUrlFromEnv(), request?: IncomingMessage): Promise<void> {
  const client = createClient({ url: redisUrl }) as RedisClient
  let closed = false
  const stop = async () => {
    if (closed) return
    closed = true
    try { await client.unsubscribe([liveChannelFor(userId), BROADCAST_CHANNEL]) } catch { /* 连接可能已断开 */ }
    try { await client.quit() } catch { client.destroy() }
  }
  response.on('close', () => { void stop() })
  try {
    await client.connect()
    writeSseHeaders(response, request)
    writeComment(response, 'connected')
    const emit = (raw: string) => {
      if (closed) return
      const serialized = serializeLiveEvent(raw)
      if (serialized) response.write(serialized)
    }
    await client.subscribe(liveChannelFor(userId), emit)
    await client.subscribe(BROADCAST_CHANNEL, emit)
    const keepalive = setInterval(() => { if (!closed) writeComment(response, 'ping') }, 20_000)
    await new Promise<void>(resolve => response.once('close', resolve))
    clearInterval(keepalive)
  } catch {
    if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json' })
    if (!response.writableEnded) response.end(JSON.stringify({ detail: '实时事件服务暂不可用' }))
  } finally {
    await stop()
  }
}

export function createLiveServer(options: { secret?: string; redisUrl?: string; port?: number } = {}) {
  const server = createServer((request, response) => {
    if (request.method === 'OPTIONS' && request.url === '/live/stream') {
      writeCorsHeaders(request, response)
      response.writeHead(204)
      response.end()
      return
    }
    if (request.method !== 'GET' || request.url !== '/live/stream') {
      writeCorsHeaders(request, response)
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ detail: 'Not Found' }))
      return
    }
    const userId = authorizeRequest(request, options.secret ?? process.env.GUGU_SECRET_KEY ?? process.env.SECRET_KEY ?? '')
    if (!userId) {
      writeCorsHeaders(request, response)
      response.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' })
      response.end(JSON.stringify({ detail: 'Token 无效或已过期' }))
      return
    }
    void serveLiveStream(userId, response, options.redisUrl, request)
  })
  return server
}

// tsx 启动时 process.argv[1] 指向 tsx CLI，不再等于当前模块 URL。
// 用入口文件名判断，同时保证被测试 import 时不会启动常驻服务。
const isLiveEntry = process.argv.some(argument => argument.endsWith('/api/live.ts') || argument === 'api/live.ts')
if (isLiveEntry) {
  const server = createLiveServer()
  server.listen(LIVE_API_PORT, '0.0.0.0', () => {
    console.log(`[live-api] listening on ${LIVE_API_PORT}`)
  })
}
