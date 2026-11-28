import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { WorkerConsumer, type InboundMessage, type WorkerConsumerOptions } from '../../src/workers/consumer.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve))
const message = (id: string, conversation = 'group-a'): InboundMessage => ({ id, payload: { conversation, text: `合成消息${id}` } })
function clock(t: TestContext) { t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 }) }
async function tick(t: TestContext, ms = 1000) { t.mock.timers.tick(ms); await settle() }

/** queue/lease均为隔离内存替身；覆盖实际Consumer调度、心跳和防抖，不代表真实Redis。 */
function fixture(entries: InboundMessage[], options: Pick<WorkerConsumerOptions, 'beforeBatch' | 'handleBatch'> & Partial<WorkerConsumerOptions>) {
  const queued = [...entries], stale: InboundMessage[] = [], states = new Map<string, string>(), ack: string[] = []
  let owners = 0, renewals = 0
  const consumer = new WorkerConsumer({ concurrency: 64, heartbeatIntervalMs: 20_000,
    queue: { async claimStale(count) { return stale.splice(0, count) }, async consume(count) { return queued.splice(0, count) }, async acknowledge(id) { ack.push(id) } },
    leases: {
      async claim(key, owner) { const state = states.get(key); if (state === 'completed') return 'completed'; if (state) return 'busy'; states.set(key, owner); return 'claimed' },
      async renew(key, owner) { renewals++; return states.get(key) === owner },
      async complete(key, owner) { if (states.get(key) !== owner) return false; states.set(key, 'completed'); return true },
    }, createOwner: () => `synthetic-owner-${++owners}`, stateKey: id => id,
    conversationKey: item => String(item.payload.conversation), async handle() { throw new Error('批次不能回退单消息handler') }, ...options })
  return { consumer, queued, stale, states, ack, renewals: () => renewals }
}

test('回复消息同会话防抖一秒合批，控制准备立即执行且不等普通批次', async t => {
  clock(t); const batches: string[][] = [], prepared: string[] = []
  const f = fixture([message('1'), message('control'), message('2')], {
    async beforeBatch(id, payload) { prepared.push(id); return id === 'control' ? null : payload },
    async handleBatch(items) { batches.push(items.map(p => p.id)) },
  })
  await f.consumer.runOnce(0); await settle()
  assert.deepEqual(prepared, ['1', 'control', '2']); assert.deepEqual(f.ack, ['control']); assert.equal(batches.length, 0)
  await tick(t, 999); assert.equal(batches.length, 0)
  await tick(t, 1); await f.consumer.waitForIdle()
  assert.deepEqual(batches, [['1', '2']]); assert.deepEqual(f.ack, ['control', '1', '2'])
  await f.consumer.close()
})

test('慢early准备不能把同轮准入消息拆开反转，控制回调仍立即执行', async t => {
  clock(t); const slow = deferred(), batches: string[][] = [], controls: string[] = []
  const f = fixture([message('1'), message('2'), message('control')], {
    async beforeBatch(id, payload) { if (id === '2') await slow.promise; if (id === 'control') { controls.push(id); return null } return payload },
    async handleBatch(items) { batches.push(items.map(p => p.id)) },
  })
  try {
    await f.consumer.runOnce(0); await settle(); await tick(t)
    assert.deepEqual(controls, ['control']); assert.equal(batches.length, 0)
    slow.resolve(); await settle(); await f.consumer.waitForIdle()
    assert.deepEqual(batches, [['1', '2']])
  } finally { slow.resolve(); await f.consumer.close() }
})

test('不同会话批次可并发，同一会话后续到达聚合且不与在途批次重叠', async t => {
  clock(t); const runningA = deferred(), runningB = deferred(), batches: string[][] = []
  const f = fixture([message('a1', 'a'), message('b1', 'b')], {
    async beforeBatch(_id, payload) { return payload }, async handleBatch(items) {
      batches.push(items.map(p => p.id))
      if (items[0]!.id === 'a1') await runningA.promise
      if (items[0]!.id === 'b1') await runningB.promise
    },
  })
  try {
    await f.consumer.runOnce(0); await settle(); await tick(t)
    assert.equal(batches.length, 2); assert.equal(f.ack.length, 0)
    f.queued.push(message('a2', 'a'), message('a3', 'a')); await f.consumer.runOnce(0); await settle(); await tick(t)
    assert.equal(batches.length, 2)
    runningA.resolve(); await settle(); await tick(t, 0)
    assert.deepEqual(batches[2], ['a2', 'a3'])
    runningB.resolve(); await f.consumer.waitForIdle()
  } finally { runningA.resolve(); runningB.resolve(); await f.consumer.close() }
})

test('持久批处理失败不完成或ACK，租约到期重投后completed重复只ACK', async t => {
  clock(t); let fail = true, calls = 0, preparations = 0
  const entries = [message('1'), message('2')], f = fixture(entries, {
    async beforeBatch(_id, payload) { preparations++; return payload }, async handleBatch() { calls++; if (fail) throw new Error('合成持久事务失败') },
  })
  await f.consumer.runOnce(0); await settle(); await tick(t); await f.consumer.waitForIdle()
  assert.deepEqual(f.ack, []); assert.equal(f.consumer.failures, 2)
  fail = false; f.states.clear(); f.stale.push(...entries)
  await f.consumer.runOnce(0); await settle(); await tick(t); await f.consumer.waitForIdle()
  assert.deepEqual(f.ack, ['1', '2']); assert.equal(calls, 2)
  f.stale.push(...entries); await f.consumer.runOnce(0); await f.consumer.waitForIdle()
  assert.equal(preparations, 4); assert.equal(calls, 2); assert.deepEqual(f.ack, ['1', '2', '1', '2'])
  await f.consumer.close()
})

test('防抖期间失租不交给handler，持久事务期间失租也不ACK该消息', async t => {
  clock(t); const commit = deferred(), batches: string[][] = []
  const f = fixture([message('lost-before'), message('lost-during'), message('valid')], {
    heartbeatIntervalMs: 10, async beforeBatch(_id, payload) { return payload }, async handleBatch(items) {
      batches.push(items.map(p => p.id)); await commit.promise
    },
  })
  try {
    await f.consumer.runOnce(0); await settle(); f.states.delete('lost-before'); await tick(t, 10)
    await tick(t, 990); assert.deepEqual(batches, [['lost-during', 'valid']]); assert.ok(f.renewals() >= 3)
    f.states.delete('lost-during'); await tick(t, 10); commit.resolve(); await f.consumer.waitForIdle()
    assert.deepEqual(f.ack, ['valid']); assert.notEqual(f.states.get('lost-during'), 'completed')
  } finally { commit.resolve(); await f.consumer.close() }
})

test('close强制flush已准入批次并等待写入排空，不再认领新消息', async t => {
  clock(t); const commit = deferred(), started = deferred(); let closed = false
  const f = fixture([message('1'), message('2')], {
    async beforeBatch(_id, payload) { return payload }, async handleBatch() { started.resolve(); await commit.promise },
  })
  await f.consumer.runOnce(0); await settle()
  const closing = f.consumer.close().then(() => { closed = true })
  try {
    await started.promise; assert.equal(closed, false); assert.equal(await f.consumer.runOnce(0), 0); assert.deepEqual(f.ack, [])
    commit.resolve(); await closing; assert.deepEqual(f.ack, ['1', '2'])
  } finally { commit.resolve(); await closing }
})

test('批次准备不能改变会话归属，缺半个端口配置拒绝，准入总量有界128', async t => {
  clock(t)
  assert.throws(() => fixture([], { async beforeBatch(_id, payload) { return payload } }), /同时配置/)
  const changed = fixture([message('1')], { async beforeBatch(_id, payload) { return { ...payload, conversation: 'another' } }, async handleBatch() { throw new Error('不能派发') } })
  await changed.consumer.runOnce(0); await changed.consumer.waitForIdle(); assert.deepEqual(changed.ack, []); await changed.consumer.close()
  const sizes: number[] = [], f = fixture(Array.from({ length: 129 }, (_, i) => message(String(i))), {
    async beforeBatch(_id, payload) { return payload }, async handleBatch(items) { sizes.push(items.length) },
  })
  assert.equal(await f.consumer.runOnce(0), 128); assert.equal(await f.consumer.runOnce(0), 0)
  await settle(); await tick(t); await f.consumer.waitForIdle(); assert.deepEqual(sizes, [128])
  assert.equal(await f.consumer.runOnce(0), 1); await f.consumer.close(); assert.deepEqual(sizes, [128, 1]); assert.equal(f.ack.length, 129)
})

test('阻塞读取与close并发时不在close返回后新建批次或认领消息', async () => {
  const read = deferred(); let prepared = 0
  const f = fixture([], { queue: { async claimStale() { return [] }, async consume() { await read.promise; return [message('late')] }, async acknowledge() { throw new Error('停止后不得ACK新读取') } },
    async beforeBatch(_id, payload) { prepared++; return payload }, async handleBatch() { throw new Error('停止后不得新派发') } })
  const reading = f.consumer.runOnce(0); await settle(); await f.consumer.close(); read.resolve()
  assert.equal(await reading, 0); assert.equal(prepared, 0); assert.equal(f.states.size, 0)
})
