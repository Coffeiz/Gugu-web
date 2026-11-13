import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'
import {
  createRedisAdminAuthVersionStore,
  createRedisEventPublisher,
  createRedisRateLimitCommands,
} from '../../src/adapters/redis-events.js'

function decodeCommand(buffer: Buffer): string[] | null {
  const text = buffer.toString('utf8')
  const lines = text.split('\r\n')
  if (!lines[0]?.startsWith('*')) return null
  const count = Number(lines[0].slice(1))
  if (lines.length < count * 2 + 1) return null
  return Array.from({ length: count }, (_, index) => lines[index * 2 + 2] ?? '')
}

async function fakeRedis(run: (commands: string[][]) => void) {
  const commands: string[][] = []
  const server = createServer((socket) => {
    let buffered = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      while (true) {
        const parsed = decodeCommand(buffered)
        if (!parsed) break
        const frame = bufferLength(parsed)
        buffered = buffered.subarray(frame)
        commands.push(parsed)
        const response = parsed[0] === 'INCR' ? ':7\r\n'
          : parsed[0] === 'EVAL' ? ':0\r\n'
          : parsed[0] === 'EXPIRE' || parsed[0] === 'PUBLISH' ? ':1\r\n'
            : '+OK\r\n'
        socket.write(response)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    url: `redis://test-user:test-password@127.0.0.1:${address.port}/2`,
    commands,
    close: async () => {
      run(commands)
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

function bufferLength(parts: string[]): number {
  return Buffer.byteLength(`*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('')}`)
}

test('auth-state notification uses the shared per-user Redis channel and payload', async () => {
  const redis = await fakeRedis(() => undefined)
  try {
    const publisher = createRedisEventPublisher(redis.url)
    assert.equal(await publisher.publishAuthStateChanged('9e51a4bf-07e1-4db8-9050-54a8c7356e8d'), true)
  } finally {
    await redis.close()
  }
  assert.deepEqual(redis.commands.map((command) => command[0]), ['AUTH', 'SELECT', 'PUBLISH'])
  assert.equal(redis.commands[0]?.[1], 'test-user')
  assert.equal(redis.commands[0]?.[2], 'test-password')
  assert.equal(redis.commands[1]?.[1], '2')
  assert.equal(redis.commands[2]?.[1], 'events:9e51a4bf-07e1-4db8-9050-54a8c7356e8d')
  assert.deepEqual(JSON.parse(redis.commands[2]?.[2] ?? ''), { type: 'auth.state.changed' })
})

test('calendar and timezone context revisions use the shared per-user key and seven-day TTL', async () => {
  const redis = await fakeRedis(() => undefined)
  try {
    const publisher = createRedisEventPublisher(redis.url)
    assert.equal(await publisher.bumpContextRevision('owner-1', 'timezone'), true)
    assert.equal(await publisher.bumpContextRevision('owner-1', 'calendar'), true)
  } finally {
    await redis.close()
  }
  assert.deepEqual(redis.commands, [
    ['AUTH', 'test-user', 'test-password'],
    ['SELECT', '2'],
    ['INCR', 'context-revision:owner-1'],
    ['EXPIRE', 'context-revision:owner-1', '604800'],
    ['AUTH', 'test-user', 'test-password'],
    ['SELECT', '2'],
    ['INCR', 'context-revision:owner-1'],
    ['EXPIRE', 'context-revision:owner-1', '604800'],
  ])
})

test('project/file context revisions are supported and scheduled-task changes do not bump context', async () => {
  const redis = await fakeRedis(() => undefined)
  try {
    const publisher = createRedisEventPublisher(redis.url)
    assert.equal(await publisher.bumpContextRevision('owner-1', 'projects'), true)
    assert.equal(await publisher.bumpContextRevision('owner-1', 'files'), true)
    assert.equal(await publisher.bumpContextRevision('owner-1', 'scheduled_tasks'), false)
  } finally {
    await redis.close()
  }
  assert.deepEqual(redis.commands.map((command) => command[0]), [
    'AUTH', 'SELECT', 'INCR', 'EXPIRE',
    'AUTH', 'SELECT', 'INCR', 'EXPIRE',
  ])
})

test('resource event increments shared revision and publishes the committed response metadata', async () => {
  const redis = await fakeRedis(() => undefined)
  try {
    const publisher = createRedisEventPublisher(redis.url, () => new Date('2026-11-13T00:00:00.000Z'), () => 'evt-test')
    assert.equal(await publisher.publishResourceChanged({
      ownerId: '9e51a4bf-07e1-4db8-9050-54a8c7356e8d',
      resource: 'projects',
      operation: 'create',
      entityId: 23,
      origin: 'browser-tab',
      payload: { id: 23, name: 'Synthetic project' },
    }), true)
  } finally {
    await redis.close()
  }
  assert.deepEqual(redis.commands.map((command) => command[0]), [
    'AUTH', 'SELECT', 'INCR', 'EXPIRE', 'PUBLISH',
  ])
  assert.equal(redis.commands[2]?.[1], 'live-revision:9e51a4bf-07e1-4db8-9050-54a8c7356e8d:projects')
  assert.equal(redis.commands[3]?.[1], redis.commands[2]?.[1])
  assert.equal(redis.commands[3]?.[2], '604800')
  const publication = JSON.parse(redis.commands[4]?.[2] ?? '')
  assert.deepEqual(publication, {
    protocol_version: 'live-event-v1',
    event_id: 'evt-test',
    type: 'resource.changed',
    resource: 'projects',
    operation: 'create',
    revision: 7,
    created_at: '2026-11-13T00:00:00.000Z',
    entity_id: 23,
    payload: { id: 23, name: 'Synthetic project' },
    origin: 'browser-tab',
  })
})

test('rate-limit Redis adapter increments a counter and applies its TTL', async () => {
  const redis = await fakeRedis(() => undefined)
  try {
    const commands = createRedisRateLimitCommands(redis.url)
    assert.equal(await commands.incr('rl:login:ip:hashed'), 7)
    await commands.expire('rl:login:ip:hashed', 300)
  } finally {
    await redis.close()
  }
  assert.deepEqual(redis.commands.map((command) => command[0]), [
    'AUTH', 'SELECT', 'INCR', 'AUTH', 'SELECT', 'EXPIRE',
  ])
  assert.deepEqual(redis.commands[2], ['INCR', 'rl:login:ip:hashed'])
  assert.deepEqual(redis.commands[5], ['EXPIRE', 'rl:login:ip:hashed', '300'])
})

test('admin auth version store reads and increments the shared Redis revocation key', async () => {
  const redis = await fakeRedis(() => undefined)
  try {
    const store = createRedisAdminAuthVersionStore(redis.url)
    assert.equal(await store.getAuthVersion(), 0)
    assert.equal(await store.incrementAuthVersion(), 7)
  } finally {
    await redis.close()
  }
  assert.deepEqual(redis.commands.map((command) => command[0]), [
    'AUTH', 'SELECT', 'EVAL', 'AUTH', 'SELECT', 'INCR',
  ])
  assert.deepEqual(redis.commands[2], [
    'EVAL', 'return tonumber(redis.call("GET", KEYS[1]) or "0")', '1', 'auth:admin:security-version',
  ])
  assert.deepEqual(redis.commands[5], ['INCR', 'auth:admin:security-version'])
  await assert.rejects(createRedisAdminAuthVersionStore(null).getAuthVersion(), /管理员认证服务/)
})
