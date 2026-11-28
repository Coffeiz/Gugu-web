import type { RedisCommandClient } from '../../workers/redis-stream-queue.js'
import { connectRedisSocket, defaultRespLimits, encodeCommand, parseResp, redisEndpoint, RedisProtocolError, type RedisSocket, type RespValue } from './redis-protocol.js'

export class RedisStreamCommandError extends Error {
  constructor(readonly code: 'invalid_command' | 'unavailable' | 'protocol' | 'busy_group' | 'timeout' | 'cancelled' | 'closed' = 'unavailable') {
    super('Redis Streams 操作不可用'); this.name = 'RedisStreamCommandError'
  }
}
export interface RedisStreamCommands extends RedisCommandClient {
  sendCommand(parts: string[], signal?: AbortSignal): Promise<RespValue>
  eval(script: string, keyCount: number, key: string, ...args: Array<string | number>): Promise<RespValue>
  close(): Promise<void>
}
const identifier = (value: string | undefined) => typeof value === 'string' && !!value && value.length <= 1024 && !/[\x00-\x20\x7f]/.test(value)
const integer = (value: string | undefined, max: number, min = 0) => typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) && Number(value) >= min && Number(value) <= max
const streamId = (value: string | undefined) => typeof value === 'string' && /^\d{1,20}-\d{1,20}$/.test(value)

/** 白名单针对可信Host调用方；EVAL内容仅由Gateway/lease源码提供，不接受外部请求脚本。 */
function validateCommand(parts: readonly string[]): { blockMs: number } {
  let valid = false, blockMs = 0
  if (!parts.every(value => typeof value === 'string')) throw new RedisStreamCommandError('invalid_command')
  switch (parts[0]) {
    case 'GET': valid = parts.length === 2 && identifier(parts[1]); break
    case 'EVAL': {
      const count = Number(parts[2])
      valid = parts.length >= 4 && !!parts[1] && integer(parts[2], 64, 1) && parts.length >= count + 3
        && parts.slice(3, count + 3).every(identifier)
      break
    }
    case 'XGROUP': valid = parts.length === 6 && parts[1] === 'CREATE' && identifier(parts[2]) && identifier(parts[3])
      && (parts[4] === '0' || parts[4] === '$' || streamId(parts[4])) && parts[5] === 'MKSTREAM'; break
    case 'XREADGROUP': {
      const blocking = parts.length === 11
      valid = (parts.length === 9 || blocking) && parts[1] === 'GROUP' && identifier(parts[2]) && identifier(parts[3])
        && parts[4] === 'COUNT' && integer(parts[5], 1000, 1)
        && (!blocking || parts[6] === 'BLOCK' && integer(parts[7], 300_000))
        && parts[blocking ? 8 : 6] === 'STREAMS' && identifier(parts[blocking ? 9 : 7])
        && (parts[blocking ? 10 : 8] === '>' || streamId(parts[blocking ? 10 : 8]))
      if (valid && blocking) blockMs = Number(parts[7])
      break
    }
    case 'XAUTOCLAIM': valid = parts.length === 8 && identifier(parts[1]) && identifier(parts[2]) && identifier(parts[3])
      && integer(parts[4], Number.MAX_SAFE_INTEGER) && streamId(parts[5]) && parts[6] === 'COUNT' && integer(parts[7], 1000, 1); break
    case 'XACK': valid = parts.length >= 4 && parts.length <= 1003 && identifier(parts[1]) && identifier(parts[2]) && parts.slice(3).every(streamId); break
  }
  if (!valid) throw new RedisStreamCommandError('invalid_command')
  return { blockMs }
}

/** 每条命令独立连接，阻塞读取不占用ACK/lease连接；任何未知结果均不自动重发。 */
export function createRedisStreamCommands(redisUrl: string, options: {
  timeoutMs?: number
  maxResponseBytes?: number
  maxConcurrent?: number
} = {}): RedisStreamCommands {
  let endpoint: ReturnType<typeof redisEndpoint>
  try { endpoint = redisEndpoint(redisUrl) } catch { throw new RedisStreamCommandError() }
  const maxResponseBytes = options.maxResponseBytes ?? defaultRespLimits.maxBytes, maxConcurrent = options.maxConcurrent ?? 32
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 64 || maxResponseBytes > 64 * 1024 * 1024
    || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 256
    || options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 305_000))
    throw new RedisStreamCommandError('invalid_command')
  const limits = { ...defaultRespLimits, maxBytes: maxResponseBytes, maxBulkBytes: Math.min(maxResponseBytes, defaultRespLimits.maxBulkBytes) }
  const lifetime = new AbortController(), tasks = new Set<Promise<RespValue>>()
  let closed = false
  async function run(parts: string[], caller?: AbortSignal): Promise<RespValue> {
    const { blockMs } = validateCommand(parts)
    const encoded = encodeCommand(parts)
    const signal = caller ? AbortSignal.any([caller, lifetime.signal]) : lifetime.signal
    if (signal.aborted) throw new RedisStreamCommandError(closed ? 'closed' : 'cancelled')
    let socket: RedisSocket
    try { socket = connectRedisSocket(endpoint) } catch { throw new RedisStreamCommandError() }
    const socketClosed = new Promise<void>(resolve => socket.once('close', () => resolve()))
    let failed: RedisStreamCommandError | undefined
    let buffer = Buffer.alloc(0)
    let pending: { resolve(value: RespValue): void; reject(error: RedisStreamCommandError): void } | undefined
    let rejectConnect!: (error: RedisStreamCommandError) => void
    const connected = new Promise<void>((resolve, reject) => {
      rejectConnect = reject
      socket.once(endpoint.tls ? 'secureConnect' : 'connect', () => resolve())
    })
    // 握手开始前也观察拒绝，避免close/abort竞态产生未处理拒绝。
    void connected.catch(() => undefined)
    function fail(error: RedisStreamCommandError) {
      if (failed) return
      failed = error
      rejectConnect(error); pending?.reject(error); pending = undefined
      socket.destroy()
    }
    const abort = () => fail(new RedisStreamCommandError(closed ? 'closed' : 'cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => fail(new RedisStreamCommandError('timeout')), options.timeoutMs ?? Math.max(10_000, blockMs + 5000))
    socket.on('error', () => fail(new RedisStreamCommandError()))
    socket.once('close', () => fail(new RedisStreamCommandError('protocol')))
    socket.on('data', (chunk: Buffer) => {
      if (failed) return
      try {
        if (!pending || buffer.length + chunk.length > maxResponseBytes) throw new RedisProtocolError()
        buffer = Buffer.concat([buffer, chunk])
        const parsed = parseResp(buffer, 0, limits)
        if (!parsed) return
        // 一条命令恰好一条回复；多余帧/尾随碎片不能污染下一个AUTH/SELECT/业务响应。
        if (parsed.bytes !== buffer.length) throw new RedisProtocolError()
        buffer = Buffer.alloc(0)
        const reply = pending; pending = undefined; reply.resolve(parsed.value)
      } catch (error) {
        fail(new RedisStreamCommandError(error instanceof RedisProtocolError && error.code === 'busy_group' ? 'busy_group' : 'protocol'))
      }
    })
    async function command(value: Buffer): Promise<RespValue> {
      if (failed || socket.destroyed || pending) throw failed ?? new RedisStreamCommandError('protocol')
      return new Promise<RespValue>((resolve, reject) => {
        pending = { resolve, reject }
        try { socket.write(value) } catch { fail(new RedisStreamCommandError()) }
      })
    }
    try {
      if (signal.aborted) abort()
      await connected
      if (endpoint.password) {
        const auth = endpoint.username ? ['AUTH', endpoint.username, endpoint.password] : ['AUTH', endpoint.password]
        if (await command(encodeCommand(auth)) !== 'OK') throw new RedisStreamCommandError()
      }
      if (endpoint.database && Number(endpoint.database) !== 0 && await command(encodeCommand(['SELECT', endpoint.database])) !== 'OK')
        throw new RedisStreamCommandError()
      return await command(encoded)
    } catch (error) { throw error instanceof RedisStreamCommandError ? error : new RedisStreamCommandError() }
    finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      socket.destroy(); await socketClosed
    }
  }
  function sendCommand(raw: string[], signal?: AbortSignal): Promise<RespValue> {
    if (closed) return Promise.reject(new RedisStreamCommandError('closed'))
    if (tasks.size >= maxConcurrent) return Promise.reject(new RedisStreamCommandError('unavailable'))
    let parts: string[]
    try { parts = [...raw] } catch { return Promise.reject(new RedisStreamCommandError('invalid_command')) }
    const task = run(parts, signal).catch(error => { throw error instanceof RedisStreamCommandError ? error : new RedisStreamCommandError('invalid_command') })
    tasks.add(task); void task.then(() => tasks.delete(task), () => tasks.delete(task))
    return task
  }
  return {
    sendCommand,
    eval(script, keyCount, key, ...args) { return sendCommand(['EVAL', script, String(keyCount), key, ...args.map(String)]) },
    async close() { closed = true; lifetime.abort(); await Promise.allSettled([...tasks]) },
  }
}
