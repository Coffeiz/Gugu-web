import assert from 'node:assert/strict'
import test from 'node:test'
import { createImInboundPreflight, type ImPreflightPorts } from '@gugu/core/im/inbound-preflight'
import type { RedisStreamCommands } from '../../../src/adapters/cache/redis-stream-commands.js'
import { RedisStreamCommandError } from '../../../src/adapters/cache/redis-stream-commands.js'
import { CLAIM_MESSAGE_SCRIPT, COMPLETE_MESSAGE_SCRIPT, RENEW_MESSAGE_SCRIPT } from '../../../src/workers/redis-message-lease.js'
import { createImInboundEnvelope } from '../../../src/modules/im/gateway/inbound-envelope.js'
import { NODE_IM_INBOUND_STREAM } from '../../../src/modules/im/gateway/inbox.js'
import { createNodeImWorker } from '../../../src/modules/im/gateway/worker.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed })
  return { promise, resolve, reject }
}
type Entry = { id: string; payload: Record<string, unknown> }
type Handler = Parameters<typeof createNodeImWorker>[0]['ingress']['handle']
const secret = 'synthetic-worker-envelope-secret'
const binding = { platform: 'wechat' as const, botId: '91', ownerId: '00000000-0000-4000-8000-000000000091' }
const envelope = createImInboundEnvelope(secret)
function event(id: string, sender = 'synthetic-sender'): Entry {
  return { id, payload: envelope.seal(binding, { platform: binding.platform, bot_id: binding.botId, channel_id: binding.botId,
    owner_user_id: binding.ownerId, chat_type: 'c2c', platform_user_id: sender, message_id: `synthetic-platform-${id}`,
    text: '合成聊天正文', context_token: 'synthetic-private-context', attachments: ['synthetic-attachment'] }) }
}

/** 命令替身不执行RESP或Lua；测试实际Queue/Consumer/LeaseStore/envelope及Worker装配。 */
function commandFixture(initial: Entry[] = []) {
  const calls: string[][] = [], acknowledgements: string[] = [], states = new Map<string, string>()
  const blocked = new Map<number, ReturnType<typeof deferred<unknown>>>()
  const readWaiters = new Map<number, ReturnType<typeof deferred<void>>>()
  const ackWaiters = new Map<string, ReturnType<typeof deferred<void>>>()
  const batches: Array<() => unknown> = initial.length ? [() => frame(initial)] : []
  const creation = deferred()
  let reads = 0, closed = false, gateGroup = false, groupExists = false
  function frame(entries: Entry[]) { return entries.length ? [[NODE_IM_INBOUND_STREAM, entries.map(entry => [entry.id, ['data', JSON.stringify(entry.payload)]])]] : null }
  const commands: RedisStreamCommands = {
    async sendCommand(parts) {
      if (closed) throw new RedisStreamCommandError('closed')
      calls.push([...parts])
      if (parts[0] === 'XGROUP') {
        if (gateGroup) await creation.promise
        if (groupExists) throw new RedisStreamCommandError('busy_group')
        return 'OK'
      }
      if (parts[0] === 'XAUTOCLAIM') return ['0-0', [], []]
      if (parts[0] === 'XREADGROUP') {
        const current = ++reads
        const batch = batches.shift()
        const waiting = deferred<unknown>()
        if (!batch) blocked.set(current, waiting)
        readWaiters.get(current)?.resolve()
        return batch ? batch() as never : await waiting.promise as never
      }
      if (parts[0] === 'XACK') {
        const id = parts[3]!
        acknowledgements.push(id); ackWaiters.get(id)?.resolve()
        return 1
      }
      assert.equal(parts[0], 'EVAL')
      const [, script, count, key, owner] = parts
      assert.equal(count, '1'); assert.match(key!, /^im:node:state:/)
      const current = states.get(key!)
      if (script === CLAIM_MESSAGE_SCRIPT) {
        if (current === 'completed') return 2
        if (current) return 0
        states.set(key!, owner!); return 1
      }
      if (script === COMPLETE_MESSAGE_SCRIPT) {
        if (current === owner || current === 'completed') { states.set(key!, 'completed'); return 1 }
        return 0
      }
      assert.equal(script, RENEW_MESSAGE_SCRIPT)
      return current === owner ? 1 : 0
    },
    eval(script, count, key, ...args) { return this.sendCommand(['EVAL', script, String(count), key, ...args.map(String)]) },
    async close() {
      closed = true
      creation.resolve()
      for (const pending of blocked.values()) pending.reject(new RedisStreamCommandError('closed'))
      blocked.clear()
    },
  }
  return { commands, calls, acknowledgements, states,
    get closed() { return closed }, get reads() { return reads },
    waitForRead(number: number) {
      if (reads >= number) return Promise.resolve()
      let waiting = readWaiters.get(number)
      if (!waiting) { waiting = deferred(); readWaiters.set(number, waiting) }
      return waiting.promise
    },
    waitForAck(id: string) {
      if (acknowledgements.includes(id)) return Promise.resolve()
      let waiting = ackWaiters.get(id)
      if (!waiting) { waiting = deferred(); ackWaiters.set(id, waiting) }
      return waiting.promise
    },
    releaseRead(number: number, entries: Entry[] = []) {
      const waiting = blocked.get(number); assert.ok(waiting, '指定读取必须确已阻塞')
      blocked.delete(number); waiting.resolve(frame(entries))
    },
    queueRaw(entries: unknown[]) { batches.push(() => [[NODE_IM_INBOUND_STREAM, entries]]) },
    gateGroup() { gateGroup = true }, releaseGroup() { creation.resolve() }, exists() { groupExists = true },
  }
}
function workerFixture(entries: Entry[] = [], handle: Handler = async () => null, concurrency = 2) {
  const redis = commandFixture(entries), diagnoses: string[] = []
  const worker = createNodeImWorker({ secretKey: secret, commands: redis.commands, ingress: { handle }, concurrency,
    ownership: { runtime: 'node', pythonGatewayStopped: true, pythonImConsumerStopped: true }, diagnose: code => { diagnoses.push(code) } })
  return { ...redis, redis, worker, diagnoses }
}
type IngressPorts = Parameters<typeof createNodeImWorker>[0]['ingress']
function batchWorkerFixture(entries: Entry[], ingress: Required<Pick<IngressPorts, 'handle' | 'prepare' | 'handleBatch'>> & Pick<IngressPorts, 'prepareAdmitted'>, batchDelayMs = 10, concurrency = 4) {
  const redis = commandFixture(entries), diagnoses: string[] = []
  const worker = createNodeImWorker({ secretKey: secret, commands: redis.commands,
    ingress: { ...ingress, prepareAdmitted: ingress.prepareAdmitted ?? ingress.prepare }, concurrency, batchDelayMs,
    ownership: { runtime: 'node', pythonGatewayStopped: true, pythonImConsumerStopped: true }, diagnose: code => { diagnoses.push(code) } })
  return { ...redis, redis, worker, diagnoses }
}
function groupEvent(id: string, chat = 'synthetic-group', sender = 'synthetic-sender') {
  const payload = envelope.open(binding, event(id, sender).payload)
  return { id, payload: envelope.sealAdmitted(binding, { ...payload, chat_type: 'group', chat_id: chat }) }
}

test('Python Gateway或消费者未停止时不发送任何Redis命令，消费归属不能只靠分组隔离', async () => {
  for (const ownership of [{ runtime: 'node' as const, pythonGatewayStopped: false, pythonImConsumerStopped: true },
    { runtime: 'node' as const, pythonGatewayStopped: true, pythonImConsumerStopped: false }]) {
    const redis = commandFixture()
    const worker = createNodeImWorker({ secretKey: secret, commands: redis.commands, ingress: { handle: async () => null }, concurrency: 1, ownership, diagnose() {} })
    await assert.rejects(worker.start(), /消费归属尚未切换/)
    assert.equal(redis.calls.length, 0)
    await worker.stop()
  }
})

test('真实解封保留凭据与附件，仅在ingress提交及lease完成后ACK，不把密封头当正文', async () => {
  const started = deferred(), commit = deferred()
  const seen: unknown[][] = [], entry = event('91-0')
  const f = workerFixture([entry], async (actualBinding, payload, id, signal) => {
    seen.push([actualBinding, payload, id, signal.aborted]); started.resolve(); await commit.promise; return null
  })
  try {
    await f.worker.start(); await started.promise; await f.redis.waitForRead(2)
    assert.equal(f.acknowledgements.length, 0)
    assert.notEqual(f.states.get('im:node:state:91-0'), 'completed')
    assert.equal(JSON.stringify(entry.payload).includes('synthetic-private-context'), false)
    commit.resolve(); await f.redis.waitForAck('91-0')
    assert.equal(f.states.get('im:node:state:91-0'), 'completed')
    assert.deepEqual(seen[0]![0], binding)
    const plain = seen[0]![1] as Record<string, unknown>
    assert.equal(plain.text, '合成聊天正文'); assert.equal(plain.context_token, 'synthetic-private-context')
    assert.deepEqual(plain.attachments, ['synthetic-attachment'])
    assert.equal(plain.message_id, 'synthetic-platform-91-0')
    assert.equal('__sealed_im' in plain, false)
    assert.equal(seen[0]![2], '91-0')
    assert.ok(f.calls.filter(parts => parts[0] === 'XACK').every(parts => parts[1] === NODE_IM_INBOUND_STREAM && parts[2] === 'gugu-node-im-v1'))
  } finally { commit.resolve(); await f.worker.stop() }
})

test('已completed消息重新出现只ACK不再调用ingress，BUSYGROUP允许安全恢复', async () => {
  let handled = 0
  const f = workerFixture([event('92-0')], async () => { handled++; return null })
  f.states.set('im:node:state:92-0', 'completed'); f.redis.exists()
  try {
    await f.worker.start(); await f.redis.waitForAck('92-0')
    assert.equal(handled, 0)
    assert.deepEqual(f.acknowledgements, ['92-0'])
    assert.equal(f.worker.health().messageFailures, 0)
  } finally { await f.worker.stop() }
})

test('ingress事务失败保留pending和未完成lease，不ACK也不泄露原异常正文', async () => {
  const failed = deferred()
  const f = workerFixture([event('93-0')], async () => { failed.resolve(); throw new Error('synthetic-private-transaction-body') })
  try {
    await f.worker.start(); await failed.promise; await f.redis.waitForRead(2)
    f.redis.releaseRead(2); await f.redis.waitForRead(3)
    assert.equal(f.acknowledgements.length, 0)
    assert.notEqual(f.states.get('im:node:state:93-0'), 'completed')
    assert.equal(f.worker.health().messageFailures, 1)
    assert.equal(JSON.stringify(f.diagnoses).includes('synthetic-private'), false)
  } finally { await f.worker.stop() }
})

test('stop中断阻塞读取并等待在途事务退出，不能把未完成事务或停止等同于ACK', async () => {
  const started = deferred(), aborted = deferred(), release = deferred()
  let exited = false, stopped = false
  const f = workerFixture([event('94-0')], async (_binding, _payload, _id, signal) => {
    signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    started.resolve(); await release.promise; exited = true; throw new Error('合成事务取消并回滚')
  })
  await f.worker.start(); await started.promise; await f.redis.waitForRead(2)
  const stopping = f.worker.stop().then(() => { stopped = true })
  try {
    await aborted.promise
    assert.equal(f.redis.closed, true)
    assert.equal(stopped, false); assert.equal(exited, false)
    assert.equal(f.acknowledgements.length, 0)
    release.resolve(); await stopping
    assert.equal(exited, true); assert.equal(f.worker.health().status, 'stopped')
    assert.equal(f.acknowledgements.length, 0)
    await assert.rejects(f.worker.start(), /已经启动或停止/)
  } finally { release.resolve(); await stopping }
})

test('畸形路由与被篡改密封载荷不影响同批其他消息，仅有效消息进入ingress和ACK', async () => {
  const malformed = event('95-0'), tampered = event('96-0'), valid = event('97-0', 'synthetic-other-sender')
  malformed.payload.platform = 'unsupported'
  tampered.payload.owner_user_id = '00000000-0000-4000-8000-000000000099'
  const handled: string[] = []
  const f = workerFixture([malformed, tampered, valid], async (actual, payload, id) => {
    assert.deepEqual(actual, binding); assert.equal(payload.platform_user_id, 'synthetic-other-sender')
    handled.push(id); return null
  })
  try {
    await f.worker.start(); await f.redis.waitForAck('97-0')
    assert.deepEqual(handled, ['97-0'])
    assert.deepEqual(f.acknowledgements, ['97-0'])
    assert.notEqual(f.states.get('im:node:state:95-0'), 'completed')
    assert.notEqual(f.states.get('im:node:state:96-0'), 'completed')
  } finally { await f.worker.stop() }
})

test('并发start只创建一次消费组，已满容量等待真实I/O而非形成饿死event loop的microtask循环', async () => {
  const firstStarted = deferred(), secondFinished = deferred()
  let handled = 0
  const f = workerFixture([event('98-0'), event('99-0')], async () => {
    if (++handled === 1) { firstStarted.resolve(); await new Promise<void>(resolve => setImmediate(resolve)) }
    else secondFinished.resolve()
    return null
  }, 1)
  f.redis.gateGroup()
  const starting = f.worker.start()
  await assert.rejects(f.worker.start(), /已经启动或停止/)
  f.redis.releaseGroup()
  try {
    await starting; await firstStarted.promise; await secondFinished.promise
    await f.redis.waitForAck('98-0'); await f.redis.waitForAck('99-0')
    assert.equal(f.calls.filter(parts => parts[0] === 'XGROUP').length, 1)
    assert.deepEqual(f.acknowledgements, ['98-0', '99-0'])
  } finally { await f.worker.stop() }
})

test('同批原始坏JSON和缺data字段各自留pending，不能让有效Stream消息永远排在坏条目之后', async () => {
  const valid = event('103-0'), handled: string[] = []
  const f = workerFixture([], async (_binding, payload, id) => {
    assert.equal(payload.message_id, 'synthetic-platform-103-0')
    handled.push(id); return null
  })
  f.redis.queueRaw([
    ['101-0', ['data', '{synthetic-invalid-json']],
    ['102-0', ['unrelated', 'synthetic-field']],
    [valid.id, ['data', JSON.stringify(valid.payload)]],
  ])
  try {
    await f.worker.start(); await f.redis.waitForAck('103-0')
    assert.deepEqual(handled, ['103-0'])
    assert.deepEqual(f.acknowledgements, ['103-0'])
    assert.ok(f.states.has('im:node:state:101-0'))
    assert.ok(f.states.has('im:node:state:102-0'))
    assert.notEqual(f.states.get('im:node:state:101-0'), 'completed')
    assert.notEqual(f.states.get('im:node:state:102-0'), 'completed')
  } finally { await f.worker.stop() }
})

test('Node批路径只解封一次，prepare立即消费控制且回复同群合批后逐条ACK', async () => {
  const prepared = new Map<string, Record<string, unknown>>(), batches: string[][] = [], seen = deferred()
  const first = groupEvent('111-0'), second = groupEvent('113-0', 'synthetic-group', 'synthetic-other-sender')
  const f = batchWorkerFixture([first, groupEvent('112-0'), second, first], {
    async handle() { throw new Error('批路径不能回退旧handler') },
    async prepare(actual, payload, id) {
      assert.deepEqual(actual, binding); assert.equal(payload.__sealed_im, undefined)
      assert.equal(payload.context_token, 'synthetic-private-context'); prepared.set(id, payload)
      return id !== '112-0'
    },
    async handleBatch(actual, items) {
      assert.deepEqual(actual, binding)
      for (const item of items) assert.equal(item.payload, prepared.get(item.eventId), 'prepare与batch必须共享同一解封对象')
      batches.push(items.map(p => p.eventId)); seen.resolve(); return []
    },
  })
  try {
    await f.worker.start(); await f.redis.waitForAck('112-0')
    assert.equal(batches.length, 0)
    await seen.promise; await f.redis.waitForAck('111-0'); await f.redis.waitForAck('113-0')
    assert.deepEqual(batches, [['111-0', '113-0']])
    assert.deepEqual(f.acknowledgements, ['112-0', '111-0', '113-0']); assert.equal(prepared.size, 3)
  } finally { await f.worker.stop() }
})

test('批路径按Bot会话隔离不同群和私聊，畸形密封仅自身失败', async () => {
  const bad = groupEvent('114-0'); bad.payload.owner_user_id = 'synthetic-invalid-owner'
  const privateMessage = event('117-0'); privateMessage.payload = envelope.sealAdmitted(binding, envelope.open(binding, privateMessage.payload))
  const batches: string[][] = [], f = batchWorkerFixture([bad, groupEvent('115-0', 'group-a'), groupEvent('116-0', 'group-b'), privateMessage], {
    async handle() { throw new Error('不得回退') }, async prepare() { return true },
    async handleBatch(_binding, items) { batches.push(items.map(p => p.eventId)); return [] },
  })
  try {
    await f.worker.start(); await Promise.all(['115-0', '116-0', '117-0'].map(id => f.redis.waitForAck(id)))
    assert.deepEqual(batches.map(ids => ids.join(',')).sort(), ['115-0', '116-0', '117-0'])
    assert.ok(!f.acknowledgements.includes('114-0')); assert.equal(f.worker.health().messageFailures, 1)
  } finally { await f.worker.stop() }
})

test('批次写入失败保持每条pending，Node停止会中止尚未flush的批次且不ACK', async () => {
  const attempted = deferred(), f = batchWorkerFixture([groupEvent('118-0'), groupEvent('119-0')], {
    async handle() { throw new Error('不得回退') }, async prepare() { return true },
    async handleBatch() { attempted.resolve(); throw new Error('合成敏感批次正文') },
  })
  try {
    await f.worker.start(); await attempted.promise; await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(f.acknowledgements, []); assert.equal(f.worker.health().messageFailures, 2)
    assert.notEqual(f.states.get('im:node:state:118-0'), 'completed')
  } finally { await f.worker.stop() }
  let batched = false
  const cancelled = batchWorkerFixture([groupEvent('120-0')], {
    async handle() { throw new Error('不得回退') }, async prepare() { return true }, async handleBatch() { batched = true; return [] },
  }, 1000)
  await cancelled.worker.start(); await cancelled.redis.waitForRead(2); await cancelled.worker.stop()
  assert.equal(batched, false); assert.deepEqual(cancelled.acknowledgements, [])
})

test('停止等待已开始batch事务响应取消，缺半个批次端口拒绝配置', async () => {
  const started = deferred(), release = deferred(), aborted = deferred(); let stopped = false
  const f = batchWorkerFixture([groupEvent('121-0')], {
    async handle() { throw new Error('不得回退') }, async prepare() { return true },
    async handleBatch(_binding, _items, signal) {
      signal.addEventListener('abort', () => aborted.resolve(), { once: true })
      started.resolve(); await release.promise; signal.throwIfAborted(); return []
    },
  })
  await f.worker.start(); await started.promise
  const stopping = f.worker.stop().then(() => { stopped = true })
  try { await aborted.promise; assert.equal(stopped, false); assert.deepEqual(f.acknowledgements, []) }
  finally { release.resolve(); await stopping }
  assert.deepEqual(f.acknowledgements, [])
  assert.throws(() => createNodeImWorker({ secretKey: secret, commands: commandFixture().commands, concurrency: 1,
    ingress: { async handle() { return null }, async prepare() { return true } },
    ownership: { runtime: 'node', pythonGatewayStopped: true, pythonImConsumerStopped: true }, diagnose() {} }), /必须同时配置/)
})

test('准入已满且防抖未到期时stop仍立即排空，不等待计时器释放容量', { timeout: 2000 }, async () => {
  const prepared = deferred(); let count = 0, batched = false
  const f = batchWorkerFixture([groupEvent('122-0'), groupEvent('123-0')], {
    async handle() { throw new Error('不得回退') }, async prepare() { if (++count === 2) prepared.resolve(); return true },
    async handleBatch() { batched = true; return [] },
  }, 100_000, 1)
  await f.worker.start(); await prepared.promise; await new Promise<void>(resolve => setImmediate(resolve))
  await f.worker.stop()
  assert.equal(batched, false); assert.deepEqual(f.acknowledgements, []); assert.equal(f.worker.health().status, 'stopped')
})

test('Gateway已准入旧文本/数字在排队后新建secret或choice stage时不被重新消费', async () => {
  for (const stage of ['secret', 'choice'] as const) {
    let active = false, secrets = 0, choices = 0, prepared = 0
    const controls: ImPreflightPorts = {
      async authorize() { return true }, async inspectSecret() { return active && stage === 'secret' ? { status: 'awaiting_secret', reference: 'synthetic-inspected-stage' } : { status: 'none' } },
      async applySecret(_scope, reference, action) { assert.equal(reference, 'synthetic-inspected-stage'); assert.equal(action.action, 'value'); secrets++; return { status: 'completed' } },
      async bindQqOwnerIfUnbound() {}, async consumeBinding() { return false },
      async consumeTextChoice() { if (active && stage === 'choice') { choices++; return { status: 'selected', text: '合成选项' } } return null },
      async decideShortcut() { return { action: 'run' } }, async cancel() { return false }, async reply() {},
    }
    const preflight = createImInboundPreflight(controls), id = stage === 'secret' ? '124-0' : '125-0'
    const payload = { ...envelope.open(binding, event(id).payload), text: stage === 'secret' ? '先前普通问题' : '1', attachments: [] }
    const scope = { ...binding, chatType: 'c2c' as const, chatId: null, platformUserId: 'synthetic-sender', eventId: id }
    const signal = new AbortController().signal
    assert.equal(await preflight({ scope, text: payload.text, hasPendingMedia: false, botMentioned: false }, signal), 'enqueue')
    const entry = { id, payload: envelope.sealAdmitted(binding, payload) }
    active = true
    const f = batchWorkerFixture([entry], {
      async handle() { throw new Error('可信准入不得回退普通入口') },
      async prepare() { throw new Error('不得用新prompt重解释旧文本') },
      async prepareAdmitted(actual, plain, eventId) {
        prepared++; assert.deepEqual(actual, binding); assert.equal(eventId, id); assert.equal(plain.text, payload.text)
        return true
      },
      async handleBatch() { return [] },
    })
    try {
      await f.worker.start(); await f.redis.waitForAck(id)
      assert.equal(prepared, 1); assert.equal(secrets, 0); assert.equal(choices, 0)
      // 确认stage替身确实生效：若错误重跑同一个真实Core预检，此旧文本就会被消费。
      assert.equal(await preflight({ scope, text: payload.text, hasPendingMedia: false, botMentioned: false }, signal), 'consumed')
      assert.equal(stage === 'secret' ? secrets : choices, 1)
    } finally { await f.worker.stop() }
  }
})

test('正式批队列拒绝无证明im1及伪造布尔准入，不以旧消息选择新prompt', async () => {
  let prepared = 0, handled = 0
  const raw = event('126-0'), forged = event('127-0')
  forged.payload = envelope.seal(binding, { ...envelope.open(binding, forged.payload), __preflight_done: true })
  const f = batchWorkerFixture([raw, forged, groupEvent('128-0')], {
    async handle() { throw new Error('不得回退') }, async prepare() { throw new Error('不得重跑预检') },
    async prepareAdmitted() { prepared++; return true }, async handleBatch() { handled++; return [] },
  })
  try {
    await f.worker.start(); await f.redis.waitForAck('128-0')
    assert.equal(prepared, 1); assert.equal(handled, 1); assert.deepEqual(f.acknowledgements, ['128-0'])
    assert.equal(f.worker.health().messageFailures, 2)
  } finally { await f.worker.stop() }
})
