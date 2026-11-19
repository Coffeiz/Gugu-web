import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CanonicalCompletionInput } from '@gugu/core/agent'
import { clearRedisAgentReflectionSession, createRedisAgentReflectionInbox, createRedisAgentReflectionQueue, createWebAgentReflectionFinalizer } from '../../src/modules/agent-sessions/persistence/agent-reflection-queue-redis.js'

import { createRedisScheduledTaskCommands } from '../../src/adapters/redis-events.js'
import { createOwnerReflectionWork } from '../../src/modules/agent-sessions/persistence/agent-owner-reflection-work.js'

const identity = { ownerId: '00000000-0000-4000-8000-000000000240', sessionId: '42', runId: 'synthetic-run' }
const redis = process.env.GUGU_WEBUI_TEST_REDIS_URL
const scope = { modelIdentity: 'synthetic-model', accessScopeHash: 'synthetic-scope' }
const modelScope = (_identity: typeof identity, model: typeof scope) => model.accessScopeHash

test('trivial turns only enter the reflection queue when they used tools', async () => {
  const calls: unknown[][] = []
  const enqueue = createRedisAgentReflectionQueue({ modelScope, commands: { async eval(...args) { calls.push(args); return '1' } } })
  const turn = { ...scope, identity, userMessageId: '41', userMessage: '嗯。', usedTools: false }
  assert.equal(await enqueue(turn, 10), false)
  assert.deepEqual(calls, [])
  assert.equal(await enqueue({ ...turn, usedTools: true }, 10), true)
  assert.equal(calls.length, 1)
  const payload = calls[0]?.[6]
  assert.equal(typeof payload, 'string')
  assert.equal(JSON.parse(String(payload)).userMessageId, '41')
  assert.doesNotMatch(String(payload), /userMessage"|assistantReply|嗯/u)
})

test('Node 反思队列经实际 Redis 去重、领取、重试和回执，保留新追加内容', {
  skip: !redis && '需要隔离 Redis', timeout: 10_000,
}, async () => {
  const commands = createRedisScheduledTaskCommands(redis!)
  const owner = randomUUID(), session = '42', otherSession = '43'
  let clock = 1_800_000_000_000
  const enqueue = createRedisAgentReflectionQueue({ modelScope, commands, now: () => clock })
  const claim = createRedisAgentReflectionInbox({ commands, now: () => clock })
  const queue = (runId: string, sessionId = session, threshold = 2) => enqueue({
    ...scope, modelIdentity: runId + "-signed", identity: { ownerId: owner, sessionId, runId },
    userMessageId: '41', userMessage: '请保存合成资料。', usedTools: false,
  }, threshold)
  try {
    assert.equal(await queue('r1'), true)
    assert.equal(await queue('r1'), true)
    assert.equal(await claim(), null)
    assert.equal(await queue('r2'), true)
    const batch = await claim()
    assert.ok(batch)
    assert.equal(batch.ownerId, owner)
    assert.equal(batch.sessionId, session)
    assert.deepEqual(batch.turns.map(turn => turn.runId), ['r1', 'r2'])
    await queue('other', otherSession, 1)
    assert.equal(await claim(), null, '同 owner 的另一会话不能抢占')
    await queue('r3')
    assert.equal(await batch.retry(5_000), true)
    const other = await claim()
    assert.ok(other)
    assert.equal(other.sessionId, otherSession)
    assert.equal(await other.complete(), true)
    assert.equal(await claim(), null)
    clock += 5_000
    const next = await claim()
    assert.ok(next)
    assert.equal(next.batchId, batch.batchId)
    assert.equal(await batch.complete(), false)
    assert.equal(await next.complete(), true)
    assert.equal(await claim(), null, '剩余批次未到阈值，按其自身的闲置时间调度')
    clock += 175_000
    const remaining = await claim()
    assert.ok(remaining)
    assert.deepEqual(remaining.turns.map(turn => turn.runId), ['r3'])
    await clearRedisAgentReflectionSession(commands, owner, session)
    assert.equal(await remaining.complete(), false)
    assert.equal(await claim(), null)
  } finally {
    await clearRedisAgentReflectionSession(commands, owner, session)
    await clearRedisAgentReflectionSession(commands, owner, otherSession)
  }
})

test('反思进程失租后，新消费者重新领取同一批次', { skip: !redis, timeout: 10_000 }, async () => {
  const commands = createRedisScheduledTaskCommands(redis!)
  const owner = randomUUID()
  const enqueue = createRedisAgentReflectionQueue({ modelScope, commands })
  const firstClaim = createRedisAgentReflectionInbox({ commands, leaseMs: 80 })
  const claim = createRedisAgentReflectionInbox({ commands })
  try {
    const turn = { ...scope, identity: { ...identity, ownerId: owner }, userMessageId: '41', userMessage: '处理合成任务', usedTools: true }
    await enqueue(turn, 1)
    await enqueue({ ...turn, accessScopeHash: 'updated-synthetic-scope', identity: { ...turn.identity, runId: 'second-run' } }, 1)
    const before = await firstClaim()
    assert.ok(before)
    assert.equal(before.turns.length, 1, '不同访问作用域的回合分批')
    await delay(150)
    const after = await claim()
    assert.ok(after)
    assert.equal(before.batchId, after.batchId)
    assert.equal(await before.isCurrent(), false)
    assert.equal(await after.isCurrent(), true)
    assert.equal(await before.complete(), false)
    assert.equal(await after.complete(), true)
    const changedScope = await claim()
    assert.ok(changedScope)
    assert.equal(changedScope.turns[0]?.accessScopeHash, 'updated-synthetic-scope')
    assert.equal(await changedScope.complete(), true)
  } finally { await clearRedisAgentReflectionSession(commands, owner, identity.sessionId) }
})

test('拆分超预算批次只缩短待领队首，保留其他回合和回执边界', { skip: !redis, timeout: 10_000 }, async () => {
  const commands = createRedisScheduledTaskCommands(redis!)
  const ownerId = randomUUID(), sessionId = '42'
  const enqueue = createRedisAgentReflectionQueue({ commands, modelScope })
  const claim = createRedisAgentReflectionInbox({ commands })
  try {
    for (const id of ['1', '2', '3']) {
      await enqueue({ ...scope, modelIdentity: id + '-signed', identity: { ownerId, sessionId, runId: id },
        userMessageId: id, userMessage: '处理实验资料', usedTools: false }, 1)
    }
    const full = await claim()
    assert.ok(full)
    assert.deepEqual(full.turns.map(turn => turn.runId), ['1', '2', '3'])
    assert.equal(await full.split(), true)
    assert.equal(await full.complete(), false)
    const first = await claim()
    assert.ok(first)
    assert.notEqual(first.batchId, full.batchId)
    assert.deepEqual(first.turns.map(turn => turn.runId), ['1'])
    assert.equal(await first.split(), false)
    assert.equal(await first.complete(), true)
    const rest = await claim()
    assert.ok(rest)
    assert.deepEqual(rest.turns.map(turn => turn.runId), ['2', '3'])
    assert.equal(await rest.complete(), true)
    assert.equal(await claim(), null)
  } finally { await clearRedisAgentReflectionSession(commands, ownerId, sessionId) }
})

test('反思停止时释放 Redis 租约并立即重新领取原批次', { skip: !redis, timeout: 10_000 }, async () => {
  const commands = createRedisScheduledTaskCommands(redis!)
  const ownerId = randomUUID(), sessionId = '42'
  const enqueue = createRedisAgentReflectionQueue({ commands, modelScope })
  const claim = createRedisAgentReflectionInbox({ commands })
  const controller = new AbortController()
  const stopping = new Error('停止合成消费者')
  try {
    await enqueue({ ...scope, identity: { ownerId, sessionId, runId: 'run' }, userMessageId: '1',
      userMessage: '处理合成资料', usedTools: false }, 1)
    const inFlight = await claim()
    assert.ok(inFlight)
    const work = createOwnerReflectionWork({
      claim: async () => inFlight,
      writer: {
        async reconcile() { return null },
        async snapshot() { assert.fail('停止后不能读档案') },
        async publish() { assert.fail('停止后不能发布') },
      },
      async checkSource() {
        controller.abort(stopping)
        throw stopping
      },
      async extract() { assert.fail('停止后不能请求模型') },
      diagnose: () => assert.fail('正常停止不应记为失败'),
    })
    await assert.rejects(work(controller.signal), error => error === stopping)
    const recovered = await claim()
    assert.ok(recovered)
    assert.equal(recovered.batchId, inFlight.batchId)
    assert.equal(await inFlight.complete(), false)
    assert.equal(await recovered.complete(), true)
  } finally { await clearRedisAgentReflectionSession(commands, ownerId, sessionId) }
})

test('Web reflection finalizer queues only the persisted anchor for the current Run', async () => {
  const input = {
    identity, modelIdentity: 'synthetic-model', accessScopeHash: 'synthetic-scope', requestSystemPrompt: '', requestTools: [],
    request: { area: { entries: [
      { source: 'restored_history', persistedMessageId: '40' },
      { source: 'user', persistencePolicy: 'already_persisted', persistedMessageId: '41' },
      { source: 'runtime', persistencePolicy: 'request_only', persistedMessageId: null },
    ] } },
    projection: null, text: '这次回复。', providerContextInput: null, providerCompacted: false, hadTools: true,
  } as unknown as CanonicalCompletionInput
  const queries: unknown[][] = []
  const queued: unknown[][] = []
  let diagnostics = 0
  const complete = createWebAgentReflectionFinalizer({
    pool: { async query(_sql: string, args: unknown[]) { queries.push(args); return { rows: [{ content: '用户的原始请求' }] } } } as never,
    enqueue: async (...args) => { queued.push(args); return true }, threshold: () => 10, diagnose: () => { diagnostics++ },
  })

  await complete(input, true)

  assert.deepEqual(queries, [[identity.ownerId, '42', '41', identity.runId]])
  assert.equal(queued.length, 1)
  assert.deepEqual(queued[0]?.[0], { ...scope, identity, userMessageId: '41', userMessage: '用户的原始请求', usedTools: true })
  assert.equal(queued[0]?.[1], 10)
  assert.equal(diagnostics, 0)
})

test('Web reflection finalizer skips restricted contexts and never fails a completed Run on queue errors', async () => {
  let queries = 0, diagnostics = 0
  const complete = createWebAgentReflectionFinalizer({
    pool: { async query() { queries++; return { rows: [{ content: '请求' }] } } } as never,
    enqueue: async () => { throw new Error('synthetic Redis failure') }, threshold: () => 10, diagnose: () => { diagnostics++ },
  })
  const input = { identity, text: '回复', hadTools: false, request: { area: { entries: [{ source: 'user', persistencePolicy: 'already_persisted', persistedMessageId: '1' }] } } } as unknown as CanonicalCompletionInput

  await complete(input, false)
  assert.equal(queries, 0)
  await complete(input, true)
  assert.equal(queries, 1)
  assert.equal(diagnostics, 1)
})
