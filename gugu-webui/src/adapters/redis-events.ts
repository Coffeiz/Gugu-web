import { randomUUID } from 'node:crypto'
import { connect as connectTcp, type Socket } from 'node:net'
import { connect as connectTls, type TLSSocket } from 'node:tls'
import type { RedisRateLimitCommands } from '../domains/auth/rate-limit.js'
import type { RegistrationCodeRedisCommands } from '../domains/auth/persistence/registration-codes.js'

type RedisConnection = Socket | TLSSocket
type RedisReply = string | null
type RedisCommand = (...parts: string[]) => Promise<RedisReply>

export interface ResourceChangedInput {
  ownerId: string
  resource: string
  operation: string
  entityId?: number | string
  entityIds?: Array<number | string>
  origin?: string | null
  payload?: unknown
}

export interface RedisEventPublisher {
  publishAuthStateChanged(userId: string): Promise<boolean>
  bumpContextRevision(userId: string, resource: string): Promise<boolean>
  publishResourceChanged(input: ResourceChangedInput): Promise<boolean>
}

const contextRevisionResources = new Set([
  'projects', 'calendar', 'files', 'memory', 'preferences', 'timezone', 'im_channels',
])

export function createRedisRateLimitCommands(redisUrl: string): RedisRateLimitCommands {
  return {
    async incr(key) {
      const value = await withRedis(redisUrl, (command) => command('INCR', key))
      if (value === null) throw new Error('Redis counter response invalid')
      const count = Number(value)
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('Redis counter response invalid')
      return count
    },
    async expire(key, seconds) {
      if (!Number.isSafeInteger(seconds) || seconds < 1) throw new Error('Redis expiry invalid')
      return withRedis(redisUrl, (command) => command('EXPIRE', key, String(seconds)))
    },
  }
}

export function createRedisRegistrationCodeCommands(redisUrl: string): RegistrationCodeRedisCommands {
  const integerReply = async (operation: string, command: Promise<RedisReply>): Promise<number> => {
    const value = await command
    const parsed = value === null ? NaN : Number(value)
    if (!Number.isSafeInteger(parsed)) throw new Error(`Redis ${operation} response invalid`)
    return parsed
  }
  return {
    set: (key, value, ...options) => withRedis(redisUrl, (command) => command('SET', key, value, ...options)),
    get: (key) => withRedis(redisUrl, (command) => command('GET', key)),
    incr: (key) => withRedis(redisUrl, (command) => integerReply('INCR', command('INCR', key))),
    expire: (key, seconds) => withRedis(redisUrl, (command) => integerReply('EXPIRE', command('EXPIRE', key, String(seconds)))),
    del: (...keys) => withRedis(redisUrl, (command) => integerReply('DEL', command('DEL', ...keys))),
    pttl: (key) => withRedis(redisUrl, (command) => integerReply('PTTL', command('PTTL', key))),
    eval: (script, keyCount, ...args) => {
      if (!Number.isSafeInteger(keyCount) || keyCount < 0)
        throw new Error('Redis script key count invalid')
      return withRedis(redisUrl, (command) => integerReply(
        'EVAL', command('EVAL', script, String(keyCount), ...args),
      ))
    },
  }
}

export function createRedisAdminAuthVersionStore(redisUrl: string | null) {
  const unavailable = () => new Error('管理员认证服务暂不可用')
  const parseVersion = (value: string) => {
    const version = Number(value)
    if (!Number.isSafeInteger(version) || version < 0) throw new Error('Redis admin auth version invalid')
    return version
  }
  return {
    async getAuthVersion(): Promise<number> {
      if (!redisUrl) throw unavailable()
      const value = await withRedis(redisUrl, (command) => command(
        'EVAL', 'return tonumber(redis.call("GET", KEYS[1]) or "0")', '1', 'auth:admin:security-version',
      ))
      if (value === null) throw new Error('Redis admin auth version invalid')
      return parseVersion(value)
    },
    async incrementAuthVersion(): Promise<number> {
      if (!redisUrl) throw unavailable()
      const value = await withRedis(redisUrl, (command) => command('INCR', 'auth:admin:security-version'))
      if (value === null) throw new Error('Redis admin auth version invalid')
      return parseVersion(value)
    },
  }
}

function encodeCommand(parts: string[]): Buffer {
  const lines = [`*${parts.length}`]
  for (const part of parts) lines.push(`$${Buffer.byteLength(part)}`, part)
  return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8')
}

function redisError(line: string): Error {
  return new Error(`Redis command failed (${line.slice(1, 128)})`)
}

function readRedisReply(buffer: Buffer): { value: RedisReply; bytes: number } | null {
  const headerEnd = buffer.indexOf('\r\n')
  if (headerEnd < 0) return null
  const header = buffer.subarray(0, headerEnd).toString('utf8')
  const marker = header[0]
  const payload = header.slice(1)
  if (marker === '+' || marker === ':') return { value: payload, bytes: headerEnd + 2 }
  if (marker === '-') throw redisError(header)
  if (marker !== '$') throw new Error('Unsupported Redis response')

  if (!/^-?\d+$/.test(payload)) throw new Error('Invalid Redis bulk response')
  const length = Number(payload)
  if (length === -1) return { value: null, bytes: headerEnd + 2 }
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid Redis bulk response')
  const bodyStart = headerEnd + 2
  const bodyEnd = bodyStart + length
  if (buffer.length < bodyEnd + 2) return null
  if (buffer[bodyEnd] !== 13 || buffer[bodyEnd + 1] !== 10)
    throw new Error('Invalid Redis bulk response terminator')
  return { value: buffer.subarray(bodyStart, bodyEnd).toString('utf8'), bytes: bodyEnd + 2 }
}

async function withRedis<T>(redisUrl: string, work: (command: RedisCommand) => Promise<T>): Promise<T> {
  const url = new URL(redisUrl)
  if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname)
    throw new Error('Redis URL invalid')
  if (url.search || url.hash) throw new Error('Redis URL has unsupported components')
  const port = Number(url.port || (url.protocol === 'rediss:' ? 6380 : 6379))
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const socket = url.protocol === 'rediss:'
    ? connectTls({ host, port, servername: host })
    : connectTcp({ host, port })
  socket.setTimeout(5_000, () => socket.destroy(new Error('Redis command timed out')))

  let buffered = Buffer.alloc(0)
  let resolveReply: ((value: RedisReply) => void) | undefined
  let rejectReply: ((error: Error) => void) | undefined
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    let parsed: { value: RedisReply; bytes: number } | null
    try {
      parsed = readRedisReply(buffered)
    } catch (error) {
      const reject = rejectReply
      resolveReply = undefined
      rejectReply = undefined
      reject?.(error instanceof Error ? error : new Error('Redis response invalid'))
      return
    }
    if (!parsed) return
    buffered = buffered.subarray(parsed.bytes)
    const resolve = resolveReply
    resolveReply = undefined
    rejectReply = undefined
    resolve?.(parsed.value)
  })
  socket.on('error', (error) => rejectReply?.(error))
  socket.once('close', () => rejectReply?.(new Error('Redis connection closed')))

  const connected = new Promise<void>((resolve, reject) => {
    const readyEvent = url.protocol === 'rediss:' ? 'secureConnect' : 'connect'
    socket.once(readyEvent, resolve)
    socket.once('error', reject)
  })
  const command: RedisCommand = (...parts) => new Promise((resolve, reject) => {
    if (resolveReply || rejectReply) return reject(new Error('Redis command already in flight'))
    resolveReply = resolve
    rejectReply = reject
    socket.write(encodeCommand(parts))
  })

  try {
    await connected
    const password = decodeURIComponent(url.password)
    const username = decodeURIComponent(url.username)
    if (password) {
      if (username) await command('AUTH', username, password)
      else await command('AUTH', password)
    }
    const database = url.pathname.replace(/^\//, '')
    if (database) {
      if (!/^\d+$/.test(database)) throw new Error('Redis database number invalid')
      if (Number(database) !== 0) await command('SELECT', database)
    }
    return await work(command)
  } finally {
    socket.end()
  }
}

function reportFailure(operation: string): void {
  console.error(`gugu-webui ${operation} failed`)
}

export function createRedisEventPublisher(
  redisUrl: string,
  now: () => Date = () => new Date(),
  eventId: () => string = () => `evt-${randomUUID().replaceAll('-', '')}`,
): RedisEventPublisher {
  return {
    async publishAuthStateChanged(userId) {
      try {
        await withRedis(redisUrl, (command) => command(
          'PUBLISH', `events:${userId}`, JSON.stringify({ type: 'auth.state.changed' }),
        ))
        return true
      } catch {
        reportFailure('auth state notification')
        return false
      }
    },

    async bumpContextRevision(userId, resource) {
      if (!contextRevisionResources.has(resource)) return false
      try {
        await withRedis(redisUrl, async (command) => {
          const key = `context-revision:${userId}`
          await command('INCR', key)
          await command('EXPIRE', key, String(60 * 60 * 24 * 7))
        })
        return true
      } catch {
        reportFailure('context revision')
        return false
      }
    },

    async publishResourceChanged(input) {
      try {
        await withRedis(redisUrl, async (command) => {
          const revisionKey = `live-revision:${input.ownerId}:${input.resource}`
          const revision = Number(await command('INCR', revisionKey))
          if (!Number.isSafeInteger(revision) || revision < 1)
            throw new Error('Redis revision invalid')
          await command('EXPIRE', revisionKey, String(60 * 60 * 24 * 7))
          const payload: Record<string, unknown> = {
            protocol_version: 'live-event-v1',
            event_id: eventId(),
            type: 'resource.changed',
            resource: input.resource,
            operation: input.operation,
            revision,
            created_at: now().toISOString(),
          }
          if (input.entityId !== undefined) payload.entity_id = input.entityId
          if (input.entityIds !== undefined) payload.entity_ids = input.entityIds
          if (input.payload !== undefined) payload.payload = input.payload
          if (input.origin) payload.origin = input.origin
          return command('PUBLISH', `events:${input.ownerId}`, JSON.stringify(payload))
        })
        return true
      } catch {
        reportFailure('resource notification')
        return false
      }
    },
  }
}
