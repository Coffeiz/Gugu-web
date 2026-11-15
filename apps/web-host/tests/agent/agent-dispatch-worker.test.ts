import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentDispatchLease } from '../../src/domains/agent-sessions/persistence/agent-run-dispatch-postgres.js'
import { createAgentDispatchWorker } from '../../src/domains/agent-sessions/agent-dispatch-worker.js'
const lease: AgentDispatchLease = { identity: { ownerId: 'owner', sessionId: '1', runId: 'run' }, token: 'token', fence: 1, mode: 'resume', cancelRequested: true, input: { userMessageId: 1, locale: null, origin: null, accessVersion: 'a'.repeat(64), v: 2, source: 'web' } }
test('缺少可信恢复器时保留任务，不调用 Harness 或推进队列', async () => {
  let finished = false
  const worker = createAgentDispatchWorker({ async failStart() { return false }, dispatch: { async setReconstructionStatus() { return true }, async claim() { return lease }, async renew() { return true }, async cancellationRequested() { return true }, async finish() { finished = true; return true }, async settleExpired() { return false } }, async reconstruct() { return null } })
  assert.equal(await worker.runOnce('owner', '1'), 'unavailable')
  assert.equal(finished, false)
})
test('领取后发生的取消仍先于恢复执行，已有 checkpoint 只使用 resume', async () => {
  const order: string[] = []
  const worker = createAgentDispatchWorker({ async failStart() { return false }, dispatch: { async setReconstructionStatus() { return true }, async claim() { return { ...lease, cancelRequested: false } }, async renew() { return true }, async cancellationRequested() { return true }, async finish() { order.push('finish'); return true }, async settleExpired() { return false } }, async reconstruct() { return {
    cancellation: { async request() { order.push('marker') }, async notify() { order.push('notify') } },
    harness: { async *start() { throw new Error('不得重新开始') }, async *resume() { order.push('resume'); return {} as never } },
    async close() { order.push('close') },
  } } })
  assert.equal(await worker.runOnce('owner', '1'), 'settled')
  assert.deepEqual(order, ['marker', 'notify', 'resume', 'close', 'finish'])
})

test('新运行将持久用户消息作为 checkpoint 锚点', async () => {
  let anchor: string | undefined
  const worker = createAgentDispatchWorker({ async failStart() { return false }, dispatch: { async setReconstructionStatus() { return true }, async claim() { return { ...lease, mode: 'start' as const, cancelRequested: false } }, async renew() { return true }, async cancellationRequested() { return false }, async finish() { return true }, async settleExpired() { return false } }, async reconstruct() { return {
    cancellation: { async request() {}, async notify() {} },
    harness: { async *start(_identity, options) { anchor = options?.anchorMessageId; return {} as never }, async *resume() { throw new Error('不得恢复') } },
    async close() {},
  } } })
  assert.equal(await worker.runOnce('owner', '1'), 'settled')
  assert.equal(anchor, '1')
})

test('空闲判定与新入队并发时不会丢失唤醒', async () => {
  let release!: () => void, calls = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const worker = createAgentDispatchWorker({ async failStart() { return false }, dispatch: { async setReconstructionStatus() { return true }, async settleExpired() { return false }, async claim() { calls++; if (calls === 1) await gate; return null }, async renew() { return true }, async cancellationRequested() { return true }, async finish() { return true } }, async reconstruct() { return null } })
  const first = worker.kick('owner', '1')
  await new Promise(resolve => setImmediate(resolve))
  const second = worker.kick('owner', '1')
  release()
  await Promise.all([first, second])
  assert.equal(calls, 2)
})

test('重建期间调度 fencing 失效不能启动 Harness，并释放重建资源', async () => {
  let closed = false, started = false
  const worker = createAgentDispatchWorker({ async failStart() { return false }, dispatch: { async setReconstructionStatus() { return true }, async claim() { return lease }, async renew() { return false }, async cancellationRequested() { throw new Error('调度租约失效') }, async finish() { throw new Error('不得推进') }, async settleExpired() { return false } }, async reconstruct() { return {
    cancellation: { async request() {}, async notify() {} },
    harness: { async *start() { started = true; return {} as never }, async *resume() { started = true; return {} as never } },
    async close() { closed = true },
  } } })
  await assert.rejects(worker.runOnce('owner', '1'), /调度租约失效/)
  assert.equal(started, false); assert.equal(closed, true)
})


test('旧载荷和伪造来源阻塞且不调用重建器', async () => {
  for (const input of [{ userMessageId: 1, locale: null, origin: null, accessVersion: 'a'.repeat(64) }, { ...lease.input, source: 'im' }]) {
    let reconstructed = false, reason = ''
    const worker = createAgentDispatchWorker({ async failStart() { return false }, dispatch: {
      async claim() { return { ...lease, input } as AgentDispatchLease }, async renew() { return true },
      async cancellationRequested() { return false }, async finish() { return false }, async settleExpired() { return false },
      async setReconstructionStatus(_lease, value) { reason = value ?? ''; return true },
    }, async reconstruct() { reconstructed = true; return null } })
    assert.equal(await worker.runOnce('owner', '1'), 'unavailable')
    assert.equal(reason, 'version_conflict'); assert.equal(reconstructed, false)
  }
})
