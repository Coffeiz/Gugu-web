import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'
import {
  createRedisAgentCancellationCommands,
  createRedisAgentActiveStatusReader,
  createRedisAgentRunRecoveryState,
  createRedisEventPublisher,
  createRedisRateLimitCommands,
  createRedisTrashPurgeNotifier,
} from '../../src/adapters/redis-events.js'

function decodeCommand(buffer: Buffer): string[] | null {
  const text = buffer.toString('utf8')
  const lines = text.split('\r\n')
  if (!lines[0]?.startsWith('*')) return null
  const count = Number(lines[0].slice(1))
  if (lines.length < count * 2 + 1) return null
  return Array.from({ length: count }, (_, index) => lines[index * 2 + 2] ?? '')
}

async function fakeRedis(run: (commands: string[][]) => void, getValues: Record<string, string> = {}) {
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
        socket.write(fakeRedisReply(parsed, getValues))
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

function fakeRedisReply(command: string[], getValues: Record<string, string>): string {
  if (command[0] === 'SET') {
    getValues[command[1] ?? ''] = command[2] ?? ''
    return '+OK\r\n'
  }
  if (command[0] === 'GET') {
    const value = getValues[command[1] ?? '']
    return value === undefined ? '$-1\r\n' : `$${Buffer.byteLength(value)}\r\n${value}\r\n`
  }
  if (command[0] === 'EXISTS') return `:${getValues[command[1] ?? ''] === undefined ? 0 : 1}\r\n`
  if (command[0] === 'DEL') {
    const removed = command.slice(1).filter((key) => {
      if (getValues[key!] === undefined) return false
      delete getValues[key!]
      return true
    }).length
    return `:${removed}\r\n`
  }
  const responses: Record<string, string> = {
    INCR: ':7\r\n', EVAL: ':0\r\n', EXPIRE: ':1\r\n', PUBLISH: ':1\r\n',
  }
  return responses[command[0] ?? ''] ?? '+OK\r\n'
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
      mutationId: 'mutation-17',
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
    mutation_id: 'mutation-17',
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

test('Agent cancellation Redis commands persist a run marker with TTL before publish', async () => {
  const redis = await fakeRedis(() => undefined)
  try {
    const commands = createRedisAgentCancellationCommands(redis.url)
    assert.equal(await commands.set('agent-run-cancel:v1:owner-1:17:run-1', 'run-1', 300), true)
    assert.equal(await commands.get('agent-run-cancel:v1:owner-1:17:run-1'), 'run-1')
    assert.equal(await commands.publish('agent-run-cancel:v1:owner-1', '{"runId":"run-1"}'), 1)
  } finally {
    await redis.close()
  }
  assert.deepEqual(redis.commands.map((command) => command[0]), [
    'AUTH', 'SELECT', 'SET', 'AUTH', 'SELECT', 'GET', 'AUTH', 'SELECT', 'PUBLISH',
  ])
  assert.deepEqual(redis.commands[2], [
    'SET', 'agent-run-cancel:v1:owner-1:17:run-1', 'run-1', 'EX', '300',
  ])
  assert.deepEqual(redis.commands[8], [
    'PUBLISH', 'agent-run-cancel:v1:owner-1', '{"runId":"run-1"}',
  ])
})

test('回收站 Worker 唤醒使用 Python 共享频道，通知不携带用户或资源数据', async () => {
  const redis = await fakeRedis(() => undefined)
  try {
    await createRedisTrashPurgeNotifier(redis.url)()
  } finally {
    await redis.close()
  }
  assert.deepEqual(redis.commands.map((command) => command[0]), ['AUTH', 'SELECT', 'PUBLISH'])
  assert.deepEqual(redis.commands[2], ['PUBLISH', 'jobs:trash-purge:wakeup', '1'])
})

test('Agent 会话运行态读取复用 genstream 状态键并按 done 区分活动快照', async () => {
  const redis = await fakeRedis(() => undefined, {
    'genstream:state:11': '{"done":false}',
    'genstream:state:12': '{"done":true}',
  })
  let statuses: Map<number, boolean>
  try {
    statuses = await createRedisAgentActiveStatusReader(redis.url)([11, 12, 13])
  } finally {
    await redis.close()
  }
  assert.deepEqual([...statuses], [[11, true], [12, false], [13, false]])
  assert.deepEqual(redis.commands.map((command) => command[0]), [
    'AUTH', 'SELECT', 'GET', 'GET', 'GET',
  ])
  assert.deepEqual(redis.commands.slice(2).map((command) => command[1]), [
    'genstream:state:11', 'genstream:state:12', 'genstream:state:13',
  ])
})

test('Agent 孤儿 run 探测区分活跃租约与僵尸快照，并复用 Python genstream 键', async () => {
  const values = {
    'genstream:state:11': '{"done":false,"owner_run_id":"dead-run"}',
    'genstream:state:12': '{"done":false,"owner_run_id":"live-run"}',
    'genstream:owner:12': 'live-run',
    'genstream:lease:12': 'live-run',
  }
  const redis = await fakeRedis(() => undefined, values)
  const recovery = createRedisAgentRunRecoveryState(redis.url)
  try {
    assert.deepEqual(await recovery.probe(11), { redisOk: true, active: true, stale: true })
    assert.deepEqual(await recovery.probe(12), { redisOk: true, active: true, stale: false })
    assert.equal(await recovery.compressionLockExists(11), false)
    await recovery.reap(11)
  } finally {
    await redis.close()
  }
  assert.equal(values['genstream:state:11'], undefined)
  assert.deepEqual(redis.commands.filter((command) => command[0] === 'DEL'), [[
    'DEL', 'genstream:state:11', 'genstream:cancel:11', 'genstream:lease:11',
    'genstream:owner:11', 'genstream:beat:11',
  ]])
})
