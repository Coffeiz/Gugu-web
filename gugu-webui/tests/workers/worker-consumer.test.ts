import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { WorkerConsumer } from '../../src/workers/consumer.js'
import { RedisMessageLeaseStore, messageStateKey } from '../../src/workers/redis-message-lease.js'
import { RedisStreamQueue } from '../../src/workers/redis-stream-queue.js'
import type { RedisCommandClient } from '../../src/workers/redis-stream-queue.js'

const redisIntegrationOptions = {
  skip: process.env.GUGU_WORKER_TEST_REDIS_URL ? false : '需要隔离临时 Redis 测试服务',
}

function realRedis() {
  const address = process.env.GUGU_WORKER_TEST_REDIS_URL
  assert.ok(address, '必须使用隔离的临时 Redis 测试服务')
  const target = new URL(address)
  const client: RedisCommandClient & { eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<number> } = {
    sendCommand(values) {
      const request = `*${values.length}\r\n${values.map(value => `$${Buffer.byteLength(value)}\r\n${value}\r\n`).join('')}`
      return new Promise((resolve, reject) => {
        const socket = createConnection({ host: target.hostname, port: Number(target.port) })
        let response = Buffer.alloc(0)
        socket.on('connect', () => socket.write(request))
        socket.on('data', chunk => {
          response = Buffer.concat([response, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
          const parsed = parseResp(response)
          if (!parsed) return
          socket.end()
          if (parsed.error) reject(new Error(parsed.error))
          else resolve(parsed.value)
        })
        socket.on('error', reject)
      })
    },
    async eval(script, keyCount, ...args) {
      return Number(await this.sendCommand(['EVAL', script, String(keyCount), ...args.map(String)]))
    },
  }
  return client
}

function parseResp(buffer: Buffer, offset = 0): { value: any; end: number; error?: string } | null {
  const marker = buffer[offset]
  const lineEnd = buffer.indexOf('\r\n', offset)
  if (lineEnd < 0) return null
  const line = buffer.toString('utf8', offset + 1, lineEnd)
  if (marker === 43) return { value: line, end: lineEnd + 2 }
  if (marker === 45) return { value: null, end: lineEnd + 2, error: line }
  if (marker === 58) return { value: Number(line), end: lineEnd + 2 }
  if (marker === 36) {
    const length = Number(line)
    if (length < 0) return { value: null, end: lineEnd + 2 }
    const end = lineEnd + 2 + length
    if (buffer.length < end + 2) return null
    return { value: buffer.toString('utf8', lineEnd + 2, end), end: end + 2 }
  }
  if (marker === 42) {
    const count = Number(line)
    if (count < 0) return { value: null, end: lineEnd + 2 }
    const values: unknown[] = []
    let cursor = lineEnd + 2
    for (let index = 0; index < count; index++) {
      const parsed = parseResp(buffer, cursor)
      if (!parsed) return null
      values.push(parsed.value)
      cursor = parsed.end
    }
    return { value: values, end: cursor }
  }
  return { value: null, end: lineEnd + 2, error: `未知 RESP 类型 ${marker}` }
}

async function pendingCount(redis: ReturnType<typeof realRedis>, stream: string, group: string) {
  const result = await redis.sendCommand(['XPENDING', stream, group])
  return Number(Array.isArray(result) ? result[0] : result)
}

function cleanAfterTest(
  context: TestContext,
  redis: ReturnType<typeof realRedis>,
  stream: string,
  group: string,
  consumers: WorkerConsumer[],
  stateKeys: Set<string>,
) {
  context.after(async () => {
    await Promise.all(consumers.map(consumer => consumer.close()))
    await redis.sendCommand(['XGROUP', 'DESTROY', stream, group]).catch(() => undefined)
    await redis.sendCommand(['DEL', stream, ...stateKeys]).catch(() => undefined)
  })
}

test('失败消息保留待重领，重复投递不越过租约，完成后重复只确认不重放', redisIntegrationOptions, async (context) => {
  const redis = realRedis()
  const stream = `im:test:${randomUUID()}`, group = 'test-group'
  await redis.sendCommand(['XGROUP', 'CREATE', stream, group, '0', 'MKSTREAM'])
  const consumers: WorkerConsumer[] = [], stateKeys = new Set<string>()
  cleanAfterTest(context, redis, stream, group, consumers, stateKeys)
  const queue = new RedisStreamQueue(redis, stream, group, 'test-consumer')
  const store = new RedisMessageLeaseStore(redis)
  const messageKeyForId = messageStateKey
  let owners = 0
  let attempts = 0
  let releaseFailure!: () => void
  let markStarted!: () => void
  const failureGate = new Promise<void>(resolve => { releaseFailure = resolve })
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const consumer = new WorkerConsumer({
    queue, leases: store, concurrency: 1,
    conversationKey: () => 'same-conversation',
    createOwner: () => `owner-${++owners}`,
    stateKey: messageKeyForId,
    staleAfterMs: 0,
    handle: async () => {
      attempts++
      if (attempts === 1) {
        markStarted()
        await failureGate
        throw new Error('合成处理错误')
      }
    },
  })
  consumers.push(consumer)
  const messageId = String(await redis.sendCommand([
    'XADD', stream, '*', 'data', JSON.stringify({ text: '合成消息' }),
  ]))
  const stateKey = messageStateKey(messageId)
  stateKeys.add(stateKey)

  assert.equal(await consumer.runOnce(0), 1)
  await started
  assert.equal(await consumer.runOnce(0), 0)
  assert.equal(attempts, 1)
  releaseFailure()
  await consumer.waitForIdle()
  assert.equal(await pendingCount(redis, stream, group), 1)
  assert.equal(await redis.eval("return redis.call('GET', KEYS[1]) == ARGV[1] and 1 or 0", 1, stateKey, 'owner-1'), 1)

  assert.equal(await consumer.runOnce(0), 1)
  await consumer.waitForIdle()
  assert.equal(await pendingCount(redis, stream, group), 1)
  assert.equal(attempts, 1)

  // 模拟租约 TTL 到期后可重新认领；清理只针对本例的随机 state key。
  await redis.sendCommand(['DEL', stateKey])
  assert.equal(await consumer.runOnce(0), 1)
  await consumer.waitForIdle()
  assert.equal(await pendingCount(redis, stream, group), 0)
  assert.equal(attempts, 2)

  // 完成状态持久化后模拟 XACK 失败；重领仅补 ACK，不重复执行 handler。
  const ackRetryStreamId = String(await redis.sendCommand([
    'XADD', stream, '*', 'data', JSON.stringify({ text: 'ACK重试' }),
  ]))
  let ackCalls = 0
  const retryQueue = {
    claimStale: (...args: [number, number]) => queue.claimStale(...args),
    consume: (...args: [number, number]) => queue.consume(...args),
    acknowledge: async (id: string) => {
      ackCalls++
      if (ackCalls === 1) throw new Error('合成ACK回包故障')
      await queue.acknowledge(id)
    },
  }
  const ackRuns: string[] = []
  const retryConsumer = new WorkerConsumer({
    queue: retryQueue, leases: store, concurrency: 1,
    conversationKey: () => 'retry-conversation',
    createOwner: () => `retry-owner-${randomUUID()}`,
    stateKey: messageKeyForId,
    handle: async id => { ackRuns.push(id) },
    staleAfterMs: 0,
  })
  consumers.push(retryConsumer)
  stateKeys.add(messageStateKey(ackRetryStreamId))
  assert.equal(await retryConsumer.runOnce(0), 1)
  await retryConsumer.waitForIdle()
  assert.equal(await pendingCount(redis, stream, group), 1)
  assert.equal(await retryConsumer.runOnce(0), 1)
  await retryConsumer.waitForIdle()
  assert.deepEqual(ackRuns, [ackRetryStreamId])
  assert.equal(await pendingCount(redis, stream, group), 0)

  // 执行期间租约被另一个 owner 接管时，旧 owner 不得确认消息。
  const stolenId = String(await redis.sendCommand([
    'XADD', stream, '*', 'data', JSON.stringify({ text: 'owner切换' }),
  ]))
  const stolenKey = messageStateKey(stolenId)
  stateKeys.add(stolenKey)
  const stolenConsumer = new WorkerConsumer({
    queue, leases: store, concurrency: 1,
    conversationKey: () => 'stolen-conversation',
    createOwner: () => 'old-owner',
    stateKey: messageKeyForId,
    handle: async () => {
      await redis.sendCommand(['SET', stolenKey, 'new-owner', 'EX', '120'])
    },
    staleAfterMs: 0,
  })
  consumers.push(stolenConsumer)
  assert.equal(await stolenConsumer.runOnce(0), 1)
  await stolenConsumer.waitForIdle()
  assert.equal(await pendingCount(redis, stream, group), 1)
  assert.equal(await redis.eval("return redis.call('GET', KEYS[1]) == ARGV[1] and 1 or 0", 1, stolenKey, 'new-owner'), 1)

  // 持久恢复确认 run 已开始时只完成并确认，不得再次调用业务 handler。
  const recoveredId = String(await redis.sendCommand([
    'XADD', stream, '*', 'data', JSON.stringify({ text: '已持久恢复' }),
  ]))
  const recoveredConsumer = new WorkerConsumer({
    queue, leases: store, concurrency: 1,
    conversationKey: () => 'recovery-conversation',
    createOwner: () => `recovery-owner-${randomUUID()}`,
    stateKey: messageKeyForId,
    recoverStarted: async id => id === recoveredId,
    handle: async () => { throw new Error('持久检查点命中后不应重放业务副作用') },
    staleAfterMs: 0,
  })
  consumers.push(recoveredConsumer)
  stateKeys.add(messageStateKey(recoveredId))
  assert.equal(await recoveredConsumer.runOnce(0), 2)
  await recoveredConsumer.waitForIdle()
  assert.equal(await pendingCount(redis, stream, group), 1)
  assert.equal(await redis.eval("return redis.call('GET', KEYS[1]) == 'completed' and 1 or 0", 1, messageStateKey(recoveredId)), 1)

})

test('续租心跳在长处理期间延长真实Redis租约', redisIntegrationOptions, async (context) => {
  const redis = realRedis()
  const stream = `im:test:${randomUUID()}`, group = 'heartbeat-group'
  await redis.sendCommand(['XGROUP', 'CREATE', stream, group, '0', 'MKSTREAM'])
  const consumers: WorkerConsumer[] = [], stateKeys = new Set<string>()
  cleanAfterTest(context, redis, stream, group, consumers, stateKeys)
  const queue = new RedisStreamQueue(redis, stream, group, 'heartbeat-consumer')
  const messageId = String(await redis.sendCommand(['XADD', stream, '*', 'data', '{}']))
  stateKeys.add(messageStateKey(messageId))
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const consumer = new WorkerConsumer({
    queue,
    leases: new RedisMessageLeaseStore(redis),
    concurrency: 1,
    conversationKey: () => 'heartbeat-conversation',
    leaseSeconds: 1,
    heartbeatIntervalMs: 100,
    createOwner: () => `heartbeat-${randomUUID()}`,
    stateKey: messageStateKey,
    handle: async () => gate,
  })
  consumers.push(consumer)
  assert.equal(await consumer.runOnce(0), 1)
  await new Promise(resolve => setTimeout(resolve, 650))
  assert.ok(Number(await redis.sendCommand(['PTTL', messageStateKey(messageId)])) > 700)
  finish()
  await consumer.waitForIdle()
  assert.equal(await pendingCount(redis, stream, group), 0)
})

test('相同会话按序串行处理，不同会话允许并发', redisIntegrationOptions, async (context) => {
  const redis = realRedis()
  const stream = `im:test:${randomUUID()}`, group = 'conversation-group'
  await redis.sendCommand(['XGROUP', 'CREATE', stream, group, '0', 'MKSTREAM'])
  const consumers: WorkerConsumer[] = [], stateKeys = new Set<string>()
  cleanAfterTest(context, redis, stream, group, consumers, stateKeys)
  const queue = new RedisStreamQueue(redis, stream, group, 'conversation-consumer')
  for (const text of ['a1', 'a2', 'b1'])
    await redis.sendCommand(['XADD', stream, '*', 'data', JSON.stringify({
      text,
      conversation: text.startsWith('b') ? '会话B' : '会话A',
    })])
  let releaseFirstA!: () => void
  let releaseB!: () => void
  let firstAStarted!: () => void
  let secondAStarted!: () => void
  let bStarted!: () => void
  const firstAGate = new Promise<void>(resolve => { releaseFirstA = resolve })
  const bGate = new Promise<void>(resolve => { releaseB = resolve })
  const firstA = new Promise<void>(resolve => { firstAStarted = resolve })
  const secondA = new Promise<void>(resolve => { secondAStarted = resolve })
  const startedB = new Promise<void>(resolve => { bStarted = resolve })
  let activeA = 0, peakA = 0, activeAll = 0, peakAll = 0
  const consumer = new WorkerConsumer({
    queue,
    leases: new RedisMessageLeaseStore(redis),
    concurrency: 2,
    conversationKey: message => String(message.payload.conversation),
    createOwner: () => `conversation-${randomUUID()}`,
    stateKey: messageStateKey,
    handle: async (_id, payload) => {
      activeAll++
      peakAll = Math.max(peakAll, activeAll)
      if (payload.conversation === '会话A') {
        activeA++
        peakA = Math.max(peakA, activeA)
        if (payload.text === 'a1') {
          firstAStarted()
          await firstAGate
        } else secondAStarted()
        activeA--
      } else {
        bStarted()
        await bGate
      }
      activeAll--
    },
  })
  consumers.push(consumer)

  assert.equal(await consumer.runOnce(0), 3)
  await Promise.all([firstA, startedB])
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(peakA, 1)
  assert.equal(peakAll, 2)
  releaseFirstA()
  await secondA
  releaseB()
  await consumer.waitForIdle()
  assert.equal(peakA, 1)
  assert.equal(peakAll, 2)
})

test('shutdown停止新认领并等待当前写操作与确认收尾', redisIntegrationOptions, async (context) => {
  const redis = realRedis()
  const stream = `im:test:${randomUUID()}`, group = 'shutdown-group'
  await redis.sendCommand(['XGROUP', 'CREATE', stream, group, '0', 'MKSTREAM'])
  const consumers: WorkerConsumer[] = [], stateKeys = new Set<string>()
  cleanAfterTest(context, redis, stream, group, consumers, stateKeys)
  const queue = new RedisStreamQueue(redis, stream, group, 'shutdown-consumer')
  const messageId = String(await redis.sendCommand(['XADD', stream, '*', 'data', '{}']))
  stateKeys.add(messageStateKey(messageId))
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const consumer = new WorkerConsumer({
    queue,
    leases: new RedisMessageLeaseStore(redis),
    concurrency: 1,
    conversationKey: () => 'shutdown-conversation',
    createOwner: () => `shutdown-${randomUUID()}`,
    stateKey: messageStateKey,
    handle: async () => gate,
  })
  consumers.push(consumer)

  assert.equal(await consumer.runOnce(0), 1)
  const closing = consumer.close()
  assert.equal(await consumer.runOnce(0), 0)
  finish()
  await closing
  assert.equal(await pendingCount(redis, stream, group), 0)
})
