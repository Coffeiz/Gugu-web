import { connect as connectTcp, type Socket } from 'node:net'
import { connect as connectTls, type TLSSocket } from 'node:tls'

export type RedisSocket = Socket | TLSSocket
export type RespValue = string | number | null | RespValue[]
export interface RespLimits {
  maxBytes: number
  maxBulkBytes: number
  maxArrayLength: number
  maxValues: number
  maxDepth: number
  maxHeaderBytes: number
}
export const defaultRespLimits: Readonly<RespLimits> = Object.freeze({ maxBytes: 16 * 1024 * 1024,
  maxBulkBytes: 8 * 1024 * 1024, maxArrayLength: 100_000, maxValues: 200_000, maxDepth: 16, maxHeaderBytes: 8192 })
/** 只保留调用方确实需要的固定协议分类，不持有Redis原始错误正文。 */
export class RedisProtocolError extends Error {
  constructor(readonly code: 'protocol' | 'busy_group' | 'redis_error' = 'protocol') {
    super('Redis 协议不可用'); this.name = 'RedisProtocolError'
  }
}

/** 完整值才返回；深度、元素数、声明长度和实际缓冲均有上界。 */
export function parseResp(buffer: Buffer, offset = 0, limits: Readonly<RespLimits> = defaultRespLimits): { value: RespValue; bytes: number } | null {
  if (!Number.isSafeInteger(offset) || offset < 0 || buffer.length - offset > limits.maxBytes) throw new RedisProtocolError()
  let values = 0
  function parse(cursor: number, depth: number): { value: RespValue; bytes: number } | null {
    if (cursor >= buffer.length) return null
    if (depth > limits.maxDepth || ++values > limits.maxValues) throw new RedisProtocolError()
    const marker = buffer[cursor]
    if (![43, 45, 58, 36, 42].includes(marker!)) throw new RedisProtocolError()
    const lineEnd = buffer.indexOf('\r\n', cursor)
    if (lineEnd < 0) { if (buffer.length - cursor > limits.maxHeaderBytes) throw new RedisProtocolError(); return null }
    if (lineEnd - cursor > limits.maxHeaderBytes) throw new RedisProtocolError()
    const header = buffer.toString('utf8', cursor + 1, lineEnd), headerBytes = lineEnd + 2 - cursor
    if (/[\r\n]/.test(header)) throw new RedisProtocolError()
    if (marker === 43) return { value: header, bytes: headerBytes }
    if (marker === 45) throw new RedisProtocolError(/^BUSYGROUP(?: |$)/.test(header) ? 'busy_group' : 'redis_error')
    if (!/^-?(?:0|[1-9]\d*)$/.test(header)) throw new RedisProtocolError()
    const number = Number(header)
    if (!Number.isSafeInteger(number)) throw new RedisProtocolError()
    if (marker === 58) return { value: number, bytes: headerBytes }
    if (number === -1) return { value: null, bytes: headerBytes }
    if (number < 0) throw new RedisProtocolError()
    if (marker === 36) {
      if (number > limits.maxBulkBytes) throw new RedisProtocolError()
      const start = lineEnd + 2, end = start + number
      if (buffer.length < end + 2) return null
      if (buffer[end] !== 13 || buffer[end + 1] !== 10) throw new RedisProtocolError()
      return { value: buffer.toString('utf8', start, end), bytes: end + 2 - cursor }
    }
    if (number > limits.maxArrayLength || values + number > limits.maxValues) throw new RedisProtocolError()
    const result: RespValue[] = []
    let child = lineEnd + 2
    for (let index = 0; index < number; index++) {
      const parsed = parse(child, depth + 1)
      if (!parsed) return null
      result.push(parsed.value); child += parsed.bytes
    }
    return { value: result, bytes: child - cursor }
  }
  return parse(offset, 0)
}

export function encodeCommand(parts: readonly string[], maxBytes = defaultRespLimits.maxBytes): Buffer {
  if (!parts.length || parts.length > 100_000) throw new RedisProtocolError()
  const chunks: Buffer[] = [Buffer.from(`*${parts.length}\r\n`)]
  let bytes = chunks[0]!.length
  for (const part of parts) {
    if (typeof part !== 'string') throw new RedisProtocolError()
    const length = Buffer.byteLength(part), header = Buffer.from(`$${length}\r\n`)
    bytes += header.length + length + 2
    if (bytes > maxBytes) throw new RedisProtocolError()
    chunks.push(header, Buffer.from(part), Buffer.from('\r\n'))
  }
  return Buffer.concat(chunks, bytes)
}

export interface RedisEndpoint { readonly host: string; readonly port: number; readonly tls: boolean; readonly username: string; readonly password: string; readonly database: string }
/** 与订阅器、Streams共用连接协议；凭据只在内存AUTH中使用。 */
export function redisEndpoint(value: string): RedisEndpoint {
  try {
    const url = new URL(value)
    if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname || url.search || url.hash) throw new RedisProtocolError()
    const database = url.pathname.replace(/^\//, '')
    const port = Number(url.port || (url.protocol === 'rediss:' ? 6380 : 6379))
    if (database && (!/^\d+$/.test(database) || !Number.isSafeInteger(Number(database))) || port < 1 || port > 65535) throw new RedisProtocolError()
    return Object.freeze({ host: url.hostname.replace(/^\[|\]$/g, ''), port, tls: url.protocol === 'rediss:',
      username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database })
  } catch { throw new RedisProtocolError() }
}
export function connectRedisSocket(endpoint: RedisEndpoint): RedisSocket {
  try {
    return endpoint.tls ? connectTls({ host: endpoint.host, port: endpoint.port, servername: endpoint.host })
      : connectTcp({ host: endpoint.host, port: endpoint.port })
  } catch { throw new RedisProtocolError() }
}
