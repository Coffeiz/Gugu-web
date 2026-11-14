import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import test from 'node:test'
import {
  createRedisLiveSubscription,
  RedisLiveSubscriptionError,
} from '../../src/adapters/redis-live-subscription.js'

interface FakeRedisOptions {
  sendMessage?: boolean
  sendProtocolFailure?: boolean
}

interface FakeRedisServer {
  url: string
  commands: string[][]
  closed: Promise<void>
  close(): Promise<void>
}

function parseCommand(buffer: Buffer): { command: string[]; bytes: number } | null {
  const lineEnd = buffer.indexOf('\r\n')
  if (lineEnd < 0) return null
  const header = buffer.toString('utf8', 0, lineEnd)
  if (!header.startsWith('*') || !/^\*\d+$/.test(header)) throw new Error('bad command array')
  const count = Number(header.slice(1))
  const command: string[] = []
  let cursor = lineEnd + 2
  for (let index = 0; index < count; index += 1) {
    const bulkEnd = buffer.indexOf('\r\n', cursor)
    if (bulkEnd < 0) return null
    const bulkHeader = buffer.toString('utf8', cursor, bulkEnd)
    if (!/^\$\d+$/.test(bulkHeader)) throw new Error('bad command bulk header')
    const length = Number(bulkHeader.slice(1))
    const start = bulkEnd + 2
    const end = start + length
    if (buffer.length < end + 2) return null
    command.push(buffer.toString('utf8', start, end))
    cursor = end + 2
  }
  return { command, bytes: cursor }
}

function bulk(value: string): string {
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`
}

function array(values: string[]): string {
  return `*${values.length}\r\n${values.map(bulk).join('')}`
}

async function startFakeRedis(options: FakeRedisOptions = {}): Promise<FakeRedisServer> {
  const commands: string[][] = []
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      for (;;) {
        const parsed = parseCommand(buffer)
        if (!parsed) break
        buffer = buffer.subarray(parsed.bytes)
        const command = parsed.command
        commands.push(command)
        const operation = command[0]?.toUpperCase()
        if (operation === 'AUTH' || operation === 'SELECT') {
          socket.write('+OK\r\n')
        } else if (operation === 'SUBSCRIBE') {
          const channels = command.slice(1)
          channels.forEach((channel, index) => {
            socket.write(array(['subscribe', channel, String(index + 1)]))
          })
          if (options.sendMessage) {
            socket.write(array(['message', channels[0]!, '{"hello":"world"}']))
          }
          if (options.sendProtocolFailure) {
            setTimeout(() => socket.write('?invalid\r\n'), 10)
          }
        } else if (operation === 'UNSUBSCRIBE') {
          const channels = command.slice(1)
          channels.forEach((channel, index) => {
            socket.write(array(['unsubscribe', channel, String(channels.length - index - 1)]))
          })
        } else {
          socket.destroy()
        }
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    url: `redis://user%40test:pass%3Aword@127.0.0.1:${address.port}/2`,
    commands,
    closed,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
      resolveClosed()
    },
  }
}

test('Redis subscription 执行 AUTH/SELECT/SUBSCRIBE，读取 message 并在 close 时取消订阅', async () => {
  const server = await startFakeRedis({ sendMessage: true })
  const channels = ['events:user-synthetic', 'events:__broadcast__']
  let subscription: Awaited<ReturnType<ReturnType<typeof createRedisLiveSubscription>>> | null = null
  try {
    subscription = await createRedisLiveSubscription(server.url)(channels)
    const message = await subscription.next(new AbortController().signal)
    assert.deepEqual(message, { channel: channels[0], data: '{"hello":"world"}' })
    assert.deepEqual(server.commands.slice(0, 3), [
      ['AUTH', 'user@test', 'pass:word'],
      ['SELECT', '2'],
      ['SUBSCRIBE', ...channels],
    ])
    await subscription.close()
    assert.deepEqual(server.commands.at(-1), ['UNSUBSCRIBE', ...channels])
  } finally {
    await subscription?.close()
    await server.close()
  }
})

test('Redis subscription 的 AbortSignal 中断等待，随后 close 仍完成 UNSUBSCRIBE', async () => {
  const server = await startFakeRedis()
  const channels = ['events:user-synthetic', 'events:__broadcast__']
  let subscription: Awaited<ReturnType<ReturnType<typeof createRedisLiveSubscription>>> | null = null
  try {
    subscription = await createRedisLiveSubscription(server.url)(channels)
    const controller = new AbortController()
    const pending = subscription.next(controller.signal)
    controller.abort()
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError')
    await subscription.close()
    assert.deepEqual(server.commands.at(-1), ['UNSUBSCRIBE', ...channels])
  } finally {
    await subscription?.close()
    await server.close()
  }
})

test('Redis 协议损坏以无正文错误结束订阅', async () => {
  const server = await startFakeRedis({ sendProtocolFailure: true })
  let subscription: Awaited<ReturnType<ReturnType<typeof createRedisLiveSubscription>>> | null = null
  try {
    subscription = await createRedisLiveSubscription(server.url)(['events:user-synthetic'])
    await assert.rejects(
      subscription.next(new AbortController().signal),
      (error: unknown) => error instanceof RedisLiveSubscriptionError
        && !error.message.includes(server.url),
    )
  } finally {
    await subscription?.close()
    await server.close()
  }
})

test('Redis 连接不可用时返回统一错误，不带连接目标或凭据', async () => {
  const reservation = createServer()
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolve)
  })
  const address = reservation.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => error ? reject(error) : resolve())
  })

  await assert.rejects(
    createRedisLiveSubscription(`redis://private-user:private-pass@127.0.0.1:${address.port}/0`)([
      'events:user-synthetic',
    ]),
    (error: unknown) => error instanceof RedisLiveSubscriptionError
      && !error.message.includes('private-user')
      && !error.message.includes('private-pass'),
  )
})

test('未配置 Redis 时订阅以统一错误结束，不使 Live route 变成未注册路由', async () => {
  await assert.rejects(
    createRedisLiveSubscription(undefined)(['events:user-synthetic']),
    (error: unknown) => error instanceof RedisLiveSubscriptionError,
  )
})
