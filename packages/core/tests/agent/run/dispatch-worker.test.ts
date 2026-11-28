import { describe, expect, it, vi } from 'vitest'
import { AgentRunReconstructionVersionError, createAgentDispatchWorker, initialReplyState } from '../../../src/agent/index.js'
import type { AgentDispatchRuntimeLease, RunCheckpoint, RunEvent } from '../../../src/agent/index.js'
import { emptyRunUsage } from '../../../src/agent/run/lifecycle.js'

interface Lease extends AgentDispatchRuntimeLease {
  token: string
  fence: number
  cancelRequested: boolean
  input: AgentDispatchRuntimeLease['input'] & { accessVersion: string; locale: string | null; origin: string | null; v: 2; source: 'desktop' }
}

const lease: Lease = { identity: { ownerId: 'owner-synthetic', sessionId: '1', runId: 'run-synthetic' }, token: 'token', fence: 1, mode: 'resume', cancelRequested: true, input: { userMessageId: 1, locale: null, origin: null, accessVersion: 'a'.repeat(64), v: 2, source: 'desktop' } }
const event: RunEvent = { id: '合成事件', identity: lease.identity, sequence: 1, round: 0, type: 'final', payload: {} }
const done: RunCheckpoint<string> = {
  identity: lease.identity, version: 1, sequence: 1, status: 'completed', phase: 'idle', round: 0,
  context: null, text: '', roundTexts: [], displayTimeline: [], anchorMessageId: '1',
  usage: emptyRunUsage, totalUsage: emptyRunUsage, usageAppliedRound: -1, providerCursor: null,
  sanitizerCheckpoint: { kind: 'clean' }, mutated: false, unpersistedToolResult: null, files: [], providerRounds: [],
  calls: [], callIndex: 0, inflightCall: null, inflightCalls: [], parallelLimit: null, pending: null,
  queuedInteractions: [], replayCall: null, replayResultReady: false, toolResults: [], toolsDispatched: false,
  parallelCallIds: [], serialCallIds: [], isolatedCallIds: [], resolution: null, resolutionClosure: null,
  emptyRetries: 0, replyState: initialReplyState, overflowRetries: 0, overflowRecoveryPending: false,
  maxRounds: null, goalMode: false, replyChoice: 'disabled', roundRequiresTools: false, completedToolCount: 0,
  remoteStatusUnknown: false, errorCode: null, earlyExitReason: null,
}
function dispatch(overrides: Partial<Parameters<typeof createAgentDispatchWorker<string, Lease>>[0]['dispatch']> = {}) {
  return { acceptsInput: (input: Lease['input']) => input.source === 'desktop' && input.v === 2,
    setReconstructionStatus: vi.fn(async () => true), claim: vi.fn(async () => lease), renew: vi.fn(async () => true), cancellationRequested: vi.fn(async () => true), finish: vi.fn(async () => true), settleExpired: vi.fn(async () => false), ...overrides }
}

describe('Core Agent dispatch execution', () => {
  it('停机不等待其他调度器持有的执行名额，旧排队请求重开后也不认领', async () => {
    const slot = Promise.withResolvers<void>()
    const ports = dispatch()
    const worker = createAgentDispatchWorker<string, Lease>({
      dispatch: ports,
      async runExclusive(task) { await slot.promise; return task() },
      async failStart() { return false },
      async reconstruct() { return null },
    })
    const queued = worker.runOnce(lease.identity.ownerId, lease.identity.sessionId)
    await worker.close()
    worker.reopen()
    slot.resolve()
    await expect(queued).resolves.toBe('idle')
    expect(ports.claim).not.toHaveBeenCalled()
  })

  it.each([true, false])('停机停止认领并按收尾窗口处理在途任务，提前完成=%s', async finishesDuringGrace => {
    let release!: () => void, entered!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const ports = dispatch({ cancellationRequested: async () => false })
    const request = vi.fn(async () => {})
    const notify = vi.fn(async () => { release() })
    const worker = createAgentDispatchWorker<string, Lease>({
      dispatch: ports, async failStart() { return false },
      async reconstruct() {
        return {
          cancellation: { request, notify },
          harness: {
            async *start() { throw new Error('不应重新开始') },
            async *resume() { entered(); await hold; yield event; return done },
          },
          async close() {},
        }
      },
    })
    const work = worker.kick(lease.identity.ownerId, lease.identity.sessionId)
    await started
    const closing = worker.close()
    await expect(worker.runOnce(lease.identity.ownerId, '2')).resolves.toBe('idle')
    expect(request).not.toHaveBeenCalled()
    if (finishesDuringGrace) release()
    await Promise.all([closing, work])
    expect(request).toHaveBeenCalledTimes(finishesDuringGrace ? 0 : 1)
    expect(notify).toHaveBeenCalledTimes(finishesDuringGrace ? 0 : 1)
    expect(ports.claim).toHaveBeenCalledTimes(1)
    expect(ports.finish).toHaveBeenCalledWith(lease)
  })

  it('缺少可信恢复器时保留任务，不调用 Harness 或推进队列', async () => {
    const ports = dispatch()
    const worker = createAgentDispatchWorker<string, Lease>({ dispatch: ports, async failStart() { return false }, async reconstruct() { return null } })
    expect(await worker.runOnce('owner-synthetic', '1')).toBe('unavailable')
    expect(ports.setReconstructionStatus).toHaveBeenCalledWith(lease, 'unavailable')
    expect(ports.finish).not.toHaveBeenCalled()
  })

  it('租约版本不兼容时阻塞，且不读取运行资源', async () => {
    const oldLease = { ...lease, input: { userMessageId: 1 } } as unknown as Lease
    const ports = dispatch({ claim: vi.fn(async () => oldLease) })
    const reconstruct = vi.fn(async () => null)
    const worker = createAgentDispatchWorker<string, Lease>({ dispatch: ports, async failStart() { return false }, reconstruct })
    expect(await worker.runOnce('owner-synthetic', '1')).toBe('unavailable')
    expect(ports.setReconstructionStatus).toHaveBeenCalledWith(oldLease, 'version_conflict')
    expect(reconstruct).not.toHaveBeenCalled()
  })

  it('Core 识别重建版本冲突并保留持久任务', async () => {
    const ports = dispatch()
    const worker = createAgentDispatchWorker<string, Lease>({ dispatch: ports, async failStart() { return false }, async reconstruct() { throw new AgentRunReconstructionVersionError() } })
    expect(await worker.runOnce('owner-synthetic', '1')).toBe('unavailable')
    expect(ports.setReconstructionStatus).toHaveBeenCalledWith(lease, 'version_conflict')
  })

  it('领取后的取消先于 checkpoint resume，并在结束后释放资源再完成租约', async () => {
    const order: string[] = []
    const ports = dispatch({ claim: vi.fn(async () => ({ ...lease, cancelRequested: false })), finish: vi.fn(async () => { order.push('finish'); return true }) })
    const worker = createAgentDispatchWorker<string, Lease>({ dispatch: ports, async failStart() { return false }, async reconstruct() { return {
      cancellation: { async request() { order.push('marker') }, async notify() { order.push('notify') } },
      harness: { async *start() { throw new Error('不应重新开始') }, async *resume() { order.push('resume'); yield event; return done } },
      async close() { order.push('close') },
    } } })
    expect(await worker.runOnce('owner-synthetic', '1')).toBe('settled')
    expect(order).toEqual(['marker', 'notify', 'resume', 'close', 'finish'])
  })

  it('仅将 Host 附加到恢复租约的可信收据传给 Core Harness', async () => {
    const resolution = { interactionId: 'interaction-synthetic', receiptId: 'receipt-synthetic', status: 'confirmed' as const, value: null }
    let received: unknown
    const resumedLease = { ...lease, cancelRequested: false, resolution }
    const ports = dispatch({ claim: vi.fn(async () => resumedLease), cancellationRequested: vi.fn(async () => false) })
    const worker = createAgentDispatchWorker<string, Lease>({ dispatch: ports, async failStart() { return false }, async reconstruct() { return {
      cancellation: { async request() {}, async notify() {} },
      harness: { async *start() { throw new Error('不应重新开始') }, async *resume(_identity, actual) { received = actual; yield event; return done } },
      async close() {},
    } } })
    expect(await worker.runOnce('owner-synthetic', '1')).toBe('settled')
    expect(received).toEqual(resolution)
  })

  it('新启动租约附带交互收据时保留任务并拒绝重建', async () => {
    const invalid = { ...lease, mode: 'start' as const, resolution: {
      interactionId: 'interaction-synthetic', receiptId: 'receipt-synthetic', status: 'confirmed' as const, value: null,
    } }
    const ports = dispatch({ claim: vi.fn(async () => invalid) })
    const reconstruct = vi.fn(async () => null)
    const worker = createAgentDispatchWorker<string, Lease>({ dispatch: ports, async failStart() { return false }, reconstruct })
    expect(await worker.runOnce('owner-synthetic', '1')).toBe('unavailable')
    expect(ports.setReconstructionStatus).toHaveBeenCalledWith(invalid, 'version_conflict')
    expect(reconstruct).not.toHaveBeenCalled()
    expect(ports.finish).not.toHaveBeenCalled()
  })

  it('新运行以持久用户消息作为 checkpoint 锚点', async () => {
    let anchor: string | undefined
    const ports = dispatch({ claim: vi.fn(async () => ({ ...lease, mode: 'start' as const, cancelRequested: false })), cancellationRequested: vi.fn(async () => false) })
    const worker = createAgentDispatchWorker<string, Lease>({ dispatch: ports, async failStart() { return false }, async reconstruct() { return {
      cancellation: { async request() {}, async notify() {} },
      harness: { async *start(_identity, options) { anchor = options?.anchorMessageId; yield event; return done }, async *resume() { throw new Error('不应恢复') } },
      async close() {},
    } } })
    expect(await worker.runOnce('owner-synthetic', '1')).toBe('settled')
    expect(anchor).toBe('1')
  })

  it('同一会话的并发唤醒合并后会再检查一次队列', async () => {
    let release!: () => void, calls = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    const ports = dispatch({ claim: vi.fn(async () => { calls++; if (calls === 1) await gate; return null }), cancellationRequested: vi.fn(async () => false) })
    const worker = createAgentDispatchWorker<string, Lease>({ dispatch: ports, async failStart() { return false }, async reconstruct() { return null } })
    const first = worker.kick('owner-synthetic', '1')
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = worker.kick('owner-synthetic', '1')
    release()
    await Promise.all([first, second])
    expect(calls).toBe(2)
  })

  it('租约丢失时不启动 Harness，并释放已重建资源', async () => {
    let closed = false, started = false
    const ports = dispatch({ renew: vi.fn(async () => false), cancellationRequested: vi.fn(async () => { throw new Error('调度租约失效') }) })
    const worker = createAgentDispatchWorker<string, Lease>({ dispatch: ports, async failStart() { return false }, renewIntervalMs: 10, async reconstruct() { return {
      cancellation: { async request() {}, async notify() {} },
      harness: { async *start() { started = true; yield event; return done }, async *resume() { started = true; yield event; return done } },
      async close() { closed = true },
    } } })
    await expect(worker.runOnce('owner-synthetic', '1')).rejects.toThrow('调度租约失效')
    expect(started).toBe(false)
    expect(closed).toBe(true)
  })
})
