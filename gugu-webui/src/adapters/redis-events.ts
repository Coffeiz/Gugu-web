import { randomUUID } from 'node:crypto'
import { connect as connectTcp, type Socket } from 'node:net'
import { connect as connectTls, type TLSSocket } from 'node:tls'
import type { RedisRateLimitCommands } from '../domains/auth/rate-limit.js'
import type { RegistrationCodeRedisCommands } from '../domains/auth/persistence/registration-codes.js'
import type { PasswordResetRedisCommands } from '../domains/auth/password-reset.js'

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
  mutationId?: string | null
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

const claimPasswordResetScript = `
local userId = redis.call('GET', KEYS[1])
if not userId then return false end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then return false end
if redis.call('SET', KEYS[2], userId, 'PX', ttl, 'NX') ~= 'OK' then return false end
redis.call('DEL', KEYS[1])
return userId
`

const restorePasswordResetScript = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
local ttl = redis.call('PTTL', KEYS[2])
if ttl <= 0 then redis.call('DEL', KEYS[2]); return 0 end
local restored = redis.call('SET', KEYS[1], ARGV[1], 'PX', ttl, 'NX')
redis.call('DEL', KEYS[2])
if restored == 'OK' then return 1 end
return 0
`

export function createRedisPasswordResetCommands(redisUrl: string): PasswordResetRedisCommands {
  return {
    get: (key) => withRedis(redisUrl, (command) => command('GET', key)),
    set: (key, value, ...options) => withRedis(redisUrl, (command) => command('SET', key, value, ...options)),
    async del(...keys) {
      const result = await withRedis(redisUrl, (command) => command('DEL', ...keys))
      const count = result === null ? NaN : Number(result)
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('Redis delete response invalid')
      return count
    },
    claim: (tokenKey, claimKey) => withRedis(redisUrl, (command) => command(
      'EVAL', claimPasswordResetScript, '2', tokenKey, claimKey,
    )),
    async restore(tokenKey, claimKey, userId) {
      const result = await withRedis(redisUrl, (command) => command(
        'EVAL', restorePasswordResetScript, '2', tokenKey, claimKey, userId,
      ))
      return result === '1'
    },
  }
}

/** 唤醒共享 Python 回收站 Worker；数据库任务已持久化，Redis 通知失败可由 Worker 扫描恢复。 */
export function createRedisTrashPurgeNotifier(redisUrl: string): () => Promise<void> {
  return async () => {
    await withRedis(redisUrl, (command) => command('PUBLISH', 'jobs:trash-purge:wakeup', '1'))
  }
}

/** Read the WebUI session-list status snapshot with the same key and terminal rule as genstream. */
export function createRedisAgentActiveStatusReader(redisUrl: string) {
  return async (sessionIds: number[]): Promise<Map<number, boolean>> => {
    if (sessionIds.length === 0) return new Map()
    try {
      return await withRedis(redisUrl, async (command) => {
        const statuses = new Map<number, boolean>()
        for (const sessionId of sessionIds) {
          const raw = await command('GET', `genstream:state:${sessionId}`)
          statuses.set(sessionId, raw === null ? false : !Boolean((JSON.parse(raw) as { done?: unknown }).done))
        }
        return statuses
      })
    } catch {
      reportFailure('agent session status lookup')
      return new Map()
    }
  }
}

/** Probe/reap the same generation lease keys used by Python genstream. */
export function createRedisAgentRunRecoveryState(redisUrl: string) {
  return {
    async probe(sessionId: number) {
      try {
        return await withRedis(redisUrl, async (command) => {
          const raw = await command('GET', `genstream:state:${sessionId}`)
          const state = raw === null ? null : JSON.parse(raw) as { done?: unknown }
          if (state !== null && (!state || typeof state !== 'object' || Array.isArray(state)))
            throw new Error('Generation state invalid')
          const hasOwner = await command('EXISTS', `genstream:owner:${sessionId}`)
          const hasLease = await command('EXISTS', `genstream:lease:${sessionId}`)
          const hasBeat = await command('EXISTS', `genstream:beat:${sessionId}`)
          const ownerExists = hasOwner === '1'
          const leaseExists = hasLease === '1'
          const beatExists = hasBeat === '1'
          if (![hasOwner, hasLease, hasBeat].every((value) => value === '0' || value === '1'))
            throw new Error('Generation lease response invalid')
          const active = Boolean((state && !state.done) || ownerExists || leaseExists)
          return {
            redisOk: true,
            active,
            stale: active && !beatExists && !ownerExists && !leaseExists,
          }
        })
      } catch {
        reportFailure('agent run recovery probe')
        return { redisOk: false, active: null, stale: false }
      }
    },
    async reap(sessionId: number) {
      try {
        await withRedis(redisUrl, (command) => command(
          'DEL',
          `genstream:state:${sessionId}`,
          `genstream:cancel:${sessionId}`,
          `genstream:lease:${sessionId}`,
          `genstream:owner:${sessionId}`,
          `genstream:beat:${sessionId}`,
        ))
      } catch {
        reportFailure('agent run recovery reap')
      }
    },
    async compressionLockExists(sessionId: number) {
      const result = await withRedis(redisUrl, (command) =>
        command('EXISTS', `agent:context:compress:${sessionId}`),
      )
      if (result !== '0' && result !== '1') throw new Error('Compression lock response invalid')
      return result === '1'
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

export async function pingRedis(redisUrl: string): Promise<boolean> {
  return withRedis(redisUrl, async (command) => (await command('PING')) === 'PONG')
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
          if (input.mutationId) payload.mutation_id = input.mutationId
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
