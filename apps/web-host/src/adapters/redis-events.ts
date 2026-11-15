import { randomUUID } from 'node:crypto'
import { connect as connectTcp, type Socket } from 'node:net'
import { connect as connectTls, type TLSSocket } from 'node:tls'
import type { RedisRateLimitCommands } from '../domains/auth/rate-limit.js'
import type { RegistrationCodeRedisCommands } from '../domains/auth/persistence/registration-codes.js'
import type { PasswordResetRedisCommands } from '../domains/auth/password-reset.js'
import type { FilesystemAuthorizationRedisCommands } from '../domains/agent-sessions/filesystem-authorization-confirmations.js'
import type { ScheduledTaskRedisCommands } from '../modules/scheduled-tasks/persistence/redis-lease.js'

type RedisConnection = Socket | TLSSocket
type RedisReply = string | null
type RedisCommand = (...parts: string[]) => Promise<RedisReply>

/** 定时任务租约与 Python Worker 共用 Redis 锁。 */
export function createRedisScheduledTaskCommands(redisUrl: string): ScheduledTaskRedisCommands {
  return {
    set: (key, value, ...options) => withRedis(redisUrl, command => command('SET', key, value, ...options)),
    eval: (script, keyCount, ...args) => withRedis(redisUrl, command => command('EVAL', script, String(keyCount), ...args)),
    exists: key => withRedis(redisUrl, command => command('EXISTS', key)),
  }
}

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

export interface RedisAgentCancellationCommands {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<boolean>
  publish(channel: string, value: string): Promise<number>
}

const contextRevisionResources = new Set([
  'projects', 'calendar', 'files', 'memory', 'preferences', 'timezone', 'im_channels',
])

/** 与 Python 管理员认证共用撤销版本。 */
export function createRedisAdminAuthVersionStore(redisUrl: string) {
  const key = 'auth:admin:security-version'
  const parseVersion = (value: string | null): number => {
    if (value === null) return 0
    if (!/^\d+$/.test(value)) throw new Error('管理员认证版本无效')
    const version = Number(value)
    if (!Number.isSafeInteger(version)) throw new Error('管理员认证版本无效')
    return version
  }
  return {
    getAuthVersion: () => withRedis(redisUrl, async (command) => parseVersion(await command('GET', key))),
    incrementAuthVersion: () => withRedis(redisUrl, async (command) => {
      const value = await command('INCR', key)
      if (value === null) throw new Error('管理员认证版本无效')
      return parseVersion(value)
    }),
  }
}

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

/** 投递通知到现有 SSE 用户或广播频道；持久化成功不依赖 Redis 投递。 */
export function createRedisNotificationPublisher(redisUrl: string) {
  return async (target: string, notification: object): Promise<boolean> => {
    if (target !== 'all' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(target)) return false
    try {
      const channel = target === 'all' ? 'events:__broadcast__' : `events:${target}`
      await withRedis(redisUrl, command => command('PUBLISH', channel, JSON.stringify({ notification })))
      return true
    } catch {
      return false
    }
  }
}

/** 向已有管理员文件同步事件频道发布提交后的失效通知。 */
export function createRedisFileSyncPublisher(redisUrl: string) {
  return async (event: object): Promise<void> => {
    await withRedis(redisUrl, command => command('PUBLISH', 'events:filesync-admin', JSON.stringify(event)))
  }
}

/** 与 Python 文件授权运维计数共用键和过期周期。 */
export function createRedisFilesystemRevokeMetric(redisUrl: string): () => Promise<void> {
  return async () => {
    const key = `ops:filesystem-auth:${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`
    await withRedis(redisUrl, async command => {
      await command('HINCRBY', key, 'scheduled_task:revoked', '1')
      await command('EXPIRE', key, String(14 * 24 * 60 * 60))
    })
  }
}

/** 服务面板读取心跳与队列状态，不写入健康数据。 */
export function createRedisServiceStatusCommands(redisUrl: string) {
  return {
    get: (key: string) => withRedis(redisUrl, command => command('GET', key)),
    eval: (script: string) => withRedis(redisUrl, command => command('EVAL', script, '0')),
    ping: () => pingRedis(redisUrl),
  }
}

/** 管理维护任务的只读状态和超时标记使用现有 Redis 键。 */
export function createRedisAdminMaintenanceCommands(redisUrl: string) {
  return {
    get: (key: string) => withRedis(redisUrl, command => command('GET', key)),
    compareAndSet: (key: string, expected: string, value: string, ttlSeconds: number) => {
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) throw new Error('Redis expiry invalid')
      return withRedis(redisUrl, command => command('EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]);return 1 end;return 0", '1', key, expected, value, String(ttlSeconds)))
    },
    set: (key: string, value: string, ttlSeconds: number) => {
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) throw new Error('Redis expiry invalid')
      return withRedis(redisUrl, command => command('SET', key, value, 'EX', String(ttlSeconds)))
    },
  }
}

/** 定时任务授权申请和确认的无敏感数据指标。 */
export function createRedisFilesystemAuthorizationMetric(redisUrl: string) {
  return async (outcome: 'requested' | 'granted'): Promise<void> => {
    const key = `ops:filesystem-auth:${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`
    await withRedis(redisUrl, async command => {
      await command('HINCRBY', key, `scheduled_task:${outcome}`, '1')
      await command('EXPIRE', key, String(14 * 24 * 60 * 60))
    })
  }
}

/** 读取与 Python Worker 共用的 Redis 状态键。 */
export function createRedisValueReader(redisUrl: string): (key: string) => Promise<string | null> {
  return key => withRedis(redisUrl, command => command('GET', key))
}

/** 读取hash完整快照；Lua仅把RESP数组编码为字符串，复用既有认证/超时传输。 */
export function createRedisHashReader(redisUrl: string): (key: string) => Promise<Record<string, string>> {
  return async key => {
    const value = await withRedis(redisUrl, command => command('EVAL', "local rows=redis.call('HGETALL',KEYS[1]);if #rows==0 then return '[]' end;return cjson.encode(rows)", '1', key))
    const pairs: unknown = JSON.parse(value ?? 'null')
    if (!Array.isArray(pairs) || pairs.length % 2 || pairs.some(item => typeof item !== 'string')) throw new Error('Redis hash response invalid')
    const hash: Record<string, string> = Object.create(null)
    for (let index = 0; index < pairs.length; index += 2) hash[pairs[index] as string] = pairs[index + 1] as string
    return hash
  }
}

/** 读取指定范围内的 Redis 列表，空列表保持数组。 */
export function createRedisListReader(redisUrl: string): (key: string, start: number, stop: number | bigint) => Promise<string[]> {
  return async (key, start, stop) => {
    const value = await withRedis(redisUrl, command => command('EVAL', "local rows=redis.call('LRANGE',KEYS[1],ARGV[1],ARGV[2]);if #rows==0 then return '[]' end;return cjson.encode(rows)", '1', key, String(start), String(stop)))
    const rows: unknown = JSON.parse(value ?? 'null')
    if (!Array.isArray(rows) || rows.some(item => typeof item !== 'string')) throw new Error('Redis list response invalid')
    return rows
  }
}

/** Bot解绑后清平台地址；最近地址仅在平台匹配时删除，坏JSON保留。 */
export function createRedisUserBotReachCleaner(redisUrl: string) {
  return async (ownerId: string, platform: string): Promise<void> => {
    await withRedis(redisUrl, command => command('EVAL',
      "redis.call('DEL',KEYS[1]);local raw=redis.call('GET',KEYS[2]);if raw then local ok,value=pcall(cjson.decode,raw);if ok and type(value)=='table' and value.platform==ARGV[1] then redis.call('DEL',KEYS[2]) end end;return 1",
      '2', `imreach:${ownerId}:${platform}`, `imreach:${ownerId}`, platform))
  }
}

/** Remove legacy per-user chat attachment metadata and the account-level IM reach key. */
export function createRedisAccountAttachmentCleaner(redisUrl:string) {
  return async(ownerId:string):Promise<readonly string[]>=>{
    const script="local cursor='0';local keys={};repeat local page=redis.call('SCAN',cursor,'MATCH',ARGV[1],'COUNT','200');cursor=page[1];for _,key in ipairs(page[2]) do local raw=redis.call('GET',key);if raw then local ok,value=pcall(cjson.decode,raw);if ok and type(value)=='table' and type(value.storage_key)=='string' then table.insert(keys,value.storage_key) end end;redis.call('DEL',key) end until cursor=='0';redis.call('DEL',KEYS[1]);if #keys==0 then return '[]' end;return cjson.encode(keys)"
    const raw=await withRedis(redisUrl,command=>command('EVAL',script,'1',`imreach:${ownerId}`,`chatfile:${ownerId}:*`))
    if(raw===null)return []
    const parsed:unknown=JSON.parse(raw)
    if(!Array.isArray(parsed)||parsed.some(key=>typeof key!=='string'))throw new Error('账户暂存清理响应无效')
    return parsed as string[]
  }
}

/** Agent run 取消适配器使用的 Redis 命令；写入标记与发布通知分别执行。 */
export function createRedisAgentCancellationCommands(redisUrl: string): RedisAgentCancellationCommands {
  return {
    get: (key) => withRedis(redisUrl, (command) => command('GET', key)),
    async set(key, value, ttlSeconds) {
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1)
        throw new Error('Redis Agent cancellation TTL invalid')
      return (await withRedis(redisUrl, (command) => command(
        'SET', key, value, 'EX', String(ttlSeconds),
      ))) === 'OK'
    },
    async publish(channel, value) {
      const result = await withRedis(redisUrl, (command) => command('PUBLISH', channel, value))
      const subscribers = result === null ? NaN : Number(result)
      if (!Number.isSafeInteger(subscribers) || subscribers < 0)
        throw new Error('Redis Agent cancellation publish response invalid')
      return subscribers
    },
  }
}

/** 提供与 Python 确认码协议兼容的 Redis 原始命令，并保留 Lua 返回值。 */
export function createRedisFilesystemAuthorizationCommands(
  redisUrl: string,
): FilesystemAuthorizationRedisCommands {
  return {
    get: (key) => withRedis(redisUrl, (command) => command('GET', key)),
    async del(...keys) {
      const result = await withRedis(redisUrl, (command) => command('DEL', ...keys))
      const count = result === null ? NaN : Number(result)
      if (!Number.isSafeInteger(count) || count < 0)
        throw new Error('Redis filesystem authorization delete response invalid')
      return count
    },
    eval(script, keyCount, ...args) {
      if (!Number.isSafeInteger(keyCount) || keyCount < 0)
        throw new Error('Redis filesystem authorization script key count invalid')
      return withRedis(redisUrl, (command) => command(
        'EVAL', script, String(keyCount), ...args,
      ))
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
            snapshot: raw,
          }
        })
      } catch {
        reportFailure('agent run recovery probe')
        return { redisOk: false, active: null, stale: false, snapshot: null }
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
    async reapIfStale(sessionId: number, snapshot: string) {
      try {
        return await withRedis(redisUrl, async command => (await command('EVAL',
          "if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end; if redis.call('EXISTS',KEYS[3],KEYS[4],KEYS[5]) ~= 0 then return 0 end; redis.call('DEL',KEYS[1],KEYS[2]); return 1",
          '5', `genstream:state:${sessionId}`, `genstream:cancel:${sessionId}`,
          `genstream:lease:${sessionId}`, `genstream:owner:${sessionId}`, `genstream:beat:${sessionId}`, snapshot)) === '1')
      } catch {
        reportFailure('agent run recovery conditional reap')
        return false
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

/** 短期状态/挑战的通用原子存储；NX避免上游重复ID覆盖其他owner。 */
export function createRedisExpiringValueStore(redisUrl:string) {
 return {
  get:createRedisValueReader(redisUrl),
  saveIfAbsent:async(key:string,value:string,seconds:number)=>await withRedis(redisUrl,command=>command('SET',key,value,'EX',String(seconds),'NX'))==='OK',
  delete:async(key:string)=>{await withRedis(redisUrl,command=>command('DEL',key))},
 }
}

/** 飞书绑定产生的可触达地址，沿用Python两个90天协议键，不记录凭据。 */
export function createRedisFeishuReachWriter(redisUrl:string) {
 return async(ownerId:string,botId:string,openId:string):Promise<void>=>{
  const value=JSON.stringify({platform:'feishu',channel_id:botId,chat_id:null,puid:openId,context_token:''})
  await withRedis(redisUrl,command=>command('EVAL',"redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2]);redis.call('SET',KEYS[2],ARGV[1],'EX',ARGV[2]);return 'OK'",'2',`imreach:${ownerId}:feishu`,`imreach:${ownerId}`,value,String(90*86400)))
 }
}
