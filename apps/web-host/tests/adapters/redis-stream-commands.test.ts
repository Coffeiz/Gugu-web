import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
import test from 'node:test'
import { createRedisStreamCommands, RedisStreamCommandError } from '../../src/adapters/cache/redis-stream-commands.js'
import { parseResp, type RespValue } from '../../src/adapters/cache/redis-protocol.js'
import { RedisStreamQueue } from '../../src/workers/redis-stream-queue.js'
import { RedisMessageLeaseStore } from '../../src/workers/redis-message-lease.js'
import { syntheticCertificate } from '../../../../packages/core/tests/agent/providers/tls-fixture.js'

function reply(value: RespValue): string {
  if (value === null) return '$-1\r\n'
  if (typeof value === 'number') return `:${value}\r\n`
  if (Array.isArray(value)) return `*${value.length}\r\n${value.map(reply).join('')}`
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`
}
async function fakeRedis(handler: (parts: string[], socket: Socket) => void | Promise<void>, auth = true) {
  const commands: string[][] = [], sockets = new Set<Socket>()
  let connections = 0, disconnected = 0
  const server = createServer(socket => {
    connections++; sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => { sockets.delete(socket); disconnected++ })
    let buffer = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      for (;;) {
        const parsed = parseResp(buffer)
        if (!parsed) return
        buffer = buffer.subarray(parsed.bytes)
        assert.ok(Array.isArray(parsed.value) && parsed.value.every(value => typeof value === 'string'))
        const parts = parsed.value as string[]; commands.push(parts)
        if (auth && ['AUTH', 'SELECT'].includes(parts[0]!)) socket.write('+OK\r\n')
        else void Promise.resolve(handler(parts, socket)).catch(() => socket.destroy())
      }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); assert.ok(address && typeof address === 'object')
  return { url: `redis://synthetic%40user:synthetic%3Apassword@127.0.0.1:${address.port}/2`, commands,
    get connections() { return connections }, get disconnected() { return disconnected },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}
const read = ['XREADGROUP', 'GROUP', 'synthetic-group', 'synthetic-consumer', 'COUNT', '2', 'BLOCK', '100', 'STREAMS', 'im:node:inbound', '>']

test('真实分片RESP数组经过Streams Queue，AUTH/SELECT顺序正确且ACK/lease不冒充标量客户端', async () => {
  const payload = { owner_user_id: 'synthetic-owner', text: '合成正文😀' }
  const record: RespValue = ['81-0', ['data', JSON.stringify(payload)]]
  const server = await fakeRedis(async (parts, socket) => {
    const value = parts[0] === 'XREADGROUP' ? [['im:node:inbound', [record]]]
      : parts[0] === 'XAUTOCLAIM' ? ['0-0', [record], []] : parts[0] === 'XGROUP' ? 'OK' : 1
    const bytes = Buffer.from(reply(value))
    for (let index = 0; index < bytes.length && !socket.destroyed; index += 3) {
      socket.write(bytes.subarray(index, index + 3)); await new Promise<void>(resolve => setImmediate(resolve))
    }
  })
  const commands = createRedisStreamCommands(server.url)
  try {
    assert.equal(await commands.sendCommand(['XGROUP', 'CREATE', 'im:node:inbound', 'synthetic-group', '0', 'MKSTREAM']), 'OK')
    const queue = new RedisStreamQueue(commands, 'im:node:inbound', 'synthetic-group', 'synthetic-consumer')
    assert.deepEqual(await queue.consume(2, 100), [{ id: '81-0', payload }])
    assert.deepEqual(await queue.claimStale(2, 1000), [{ id: '81-0', payload }])
    await queue.acknowledge('81-0')
    assert.equal(await new RedisMessageLeaseStore(commands).claim('im:node:lease:81-0', 'synthetic-owner'), 'claimed')
    assert.deepEqual(server.commands.slice(0, 3), [['AUTH', 'synthetic@user', 'synthetic:password'], ['SELECT', '2'],
      ['XGROUP', 'CREATE', 'im:node:inbound', 'synthetic-group', '0', 'MKSTREAM']])
    assert.equal(server.connections, 5)
  } finally { await commands.close(); await server.close() }
})

test('RESP nil数组对应阻塞空读，BUSYGROUP仅暴露固定可分类码，不暴露服务端正文', async () => {
  const server = await fakeRedis((parts, socket) => { socket.write(parts[0] === 'XGROUP' ? '-BUSYGROUP synthetic-private-upstream\r\n' : '*-1\r\n') })
  const commands = createRedisStreamCommands(server.url)
  try {
    assert.equal(await commands.sendCommand(read), null)
    await assert.rejects(commands.sendCommand(['XGROUP', 'CREATE', 'im:node:inbound', 'synthetic-group', '$', 'MKSTREAM']),
      error => error instanceof RedisStreamCommandError && error.code === 'busy_group' && error.message === 'Redis Streams 操作不可用' && !('cause' in error))
  } finally { await commands.close(); await server.close() }
})

test('AUTH拒绝不发送业务命令，原错误与URL凭据不会进入安全错误', async () => {
  const server = await fakeRedis((_parts, socket) => { socket.write('-WRONGPASS synthetic:password synthetic-private-upstream\r\n') }, false)
  const commands = createRedisStreamCommands(server.url)
  try {
    await assert.rejects(commands.sendCommand(['GET', 'im:node:cursor']), error => error instanceof RedisStreamCommandError
      && !JSON.stringify(error).includes('synthetic') && !error.message.includes('password') && !('cause' in error))
    assert.deepEqual(server.commands.map(parts => parts[0]), ['AUTH'])
  } finally { await commands.close(); await server.close() }
})

test('截断、畸形、负长度、过深、超大声明和额外回复均拒绝且不重发', async () => {
  for (const value of ['$4\r\nab', '$1\r\naXX', '$-2\r\n', '*1\r\n'.repeat(18) + '+OK\r\n', '$999999999\r\n', '*999999999\r\n', ':1\r\n:2\r\n', '+bad\nline\r\n', '?bad\r\n', ':' + '9'.repeat(9000)]) {
    const server = await fakeRedis((_parts, socket) => { socket.end(value) })
    const commands = createRedisStreamCommands(server.url)
    try {
      await assert.rejects(commands.sendCommand(['GET', 'im:node:cursor']), RedisStreamCommandError)
      assert.equal(server.commands.filter(parts => parts[0] === 'GET').length, 1)
    } finally { await commands.close(); await server.close() }
  }
})

test('响应缓冲上限在未完整帧前生效，非法或非白名单命令在建连前拒绝', async () => {
  const server = await fakeRedis((_parts, socket) => { socket.write('$200\r\n' + 'a'.repeat(200)) })
  const commands = createRedisStreamCommands(server.url, { maxResponseBytes: 64 })
  try {
    for (const parts of [['FLUSHALL'], ['AUTH', 'synthetic'], ['SET', 'key', 'value'], ['EVAL', 'return 1', '0'],
      ['XGROUP', 'DESTROY', 'im:node:inbound', 'synthetic-group'], ['XACK', 'im:node:inbound', 'synthetic-group', 'invalid'],
      ['XREADGROUP', 'GROUP', 'synthetic-group', 'synthetic-consumer', 'COUNT', '1001', 'STREAMS', 'im:node:inbound', '>']])
      await assert.rejects(commands.sendCommand(parts), error => error instanceof RedisStreamCommandError && error.code === 'invalid_command')
    assert.equal(server.connections, 0)
    await assert.rejects(commands.sendCommand(['GET', 'im:node:cursor']), error => error instanceof RedisStreamCommandError && error.code === 'protocol')
  } finally { await commands.close(); await server.close() }
})

test('命令总超时、调用取消和client.close均关闭真实阻塞连接，不影响并行ACK', async () => {
  let readStarted!: () => void
  const started = new Promise<void>(resolve => { readStarted = resolve })
  const server = await fakeRedis((parts, socket) => { if (parts[0] === 'XREADGROUP') readStarted(); else socket.write(':1\r\n') })
  const timed = createRedisStreamCommands(server.url, { timeoutMs: 25 })
  const commands = createRedisStreamCommands(server.url)
  try {
    await assert.rejects(timed.sendCommand(read), error => error instanceof RedisStreamCommandError && error.code === 'timeout')
    const cancel = new AbortController(), pending = commands.sendCommand(read, cancel.signal)
    await started
    assert.equal(await commands.sendCommand(['XACK', 'im:node:inbound', 'synthetic-group', '81-0']), 1)
    cancel.abort(new Error('synthetic-private-abort-reason'))
    await assert.rejects(pending, error => error instanceof RedisStreamCommandError && error.code === 'cancelled' && !('cause' in error))
    const closed = commands.sendCommand(read)
    const rejected = assert.rejects(closed, error => error instanceof RedisStreamCommandError && error.code === 'closed')
    await commands.close(); await rejected
    await assert.rejects(commands.sendCommand(['GET', 'im:node:cursor']), error => error instanceof RedisStreamCommandError && error.code === 'closed')
    assert.ok(server.connections >= 3)
  } finally { await timed.close(); await commands.close(); await server.close() }
})

test('配置错误在连接前脱敏，rediss拒绝不可信TLS证书并且不发送AUTH', async () => {
  for (const url of ['https://synthetic:password@example.invalid', 'redis://user:%GG@example.invalid', 'redis://example.invalid/not-a-db', 'redis://example.invalid/0?secret=synthetic'])
    assert.throws(() => createRedisStreamCommands(url), RedisStreamCommandError)
  let bytes = 0
  const server = createTlsServer(syntheticCertificate(), socket => socket.on('data', chunk => { bytes += chunk.length }))
  server.on('tlsClientError', () => {})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const commands = createRedisStreamCommands(`rediss://synthetic:password@127.0.0.1:${address.port}/0`, { timeoutMs: 1000 })
  try {
    await assert.rejects(commands.sendCommand(['GET', 'im:node:cursor']), RedisStreamCommandError)
    assert.equal(bytes, 0)
  } finally { await commands.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
