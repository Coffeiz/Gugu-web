import { describe, expect, it } from 'vitest'
import { createAgentDispatchRuntime, createAgentDispatchSupervisor } from '../../../src/agent/index.js'

describe('Core Agent dispatch recovery supervisor', () => {
  it('订阅失败后仍扫描持久队列并重新订阅', async () => {
    let subscriptions = 0, closed = 0, scans = 0
    const diagnostics: string[] = [], calls: string[] = []
    let wake!: () => void
    const consumed = new Promise<void>(resolve => { wake = resolve })
    const supervisor = createAgentDispatchSupervisor({
      async subscribe() {
        if (++subscriptions === 1) throw new Error('合成订阅故障')
        return {
          next(signal: AbortSignal) { return new Promise<null>(resolve => { if (signal.aborted) resolve(null); else signal.addEventListener('abort', () => resolve(null), { once: true }) }) },
          async close() { closed++ },
        }
      },
      async listReady() { scans++; return scans === 1 ? [{ ownerId: 'owner-synthetic', sessionId: '1' }] : [] },
      async kick(owner, session) { calls.push(`${owner}:${session}`); wake() },
      async publish() { return 0 },
      diagnose(code) { diagnostics.push(code) },
      recoveryIntervalMs: 1000,
    })
    const running = await supervisor.start()
    await consumed
    await running.stop()
    await running.drain()
    expect(calls).toEqual(['owner-synthetic:1'])
    expect(subscriptions).toBe(2)
    expect(closed).toBe(1)
    expect(diagnostics).toEqual(['subscription_failed'])
  })

  it('并发启动只创建一个订阅，启动过程中关闭也释放订阅', async () => {
    let release!: () => void
    const connecting = new Promise<void>(resolve => { release = resolve })
    let subscriptions = 0, closed = 0
    const runtime = createAgentDispatchRuntime({
      chat: {
        cancellation: { async request() {}, async notify() {} },
        async prepare() { throw new Error('未发起 Chat') },
        events: { async *open() {}, async notify() {} },
        async project() { return [] },
        async failStart() {},
      },
      worker: { async reconstruct() { return null } },
      dispatch: {
        acceptsInput: () => true,
        async claim() { return null },
        async renew() { return true },
        async cancellationRequested() { return false },
        async finish() { return true },
        async settleExpired() { return false },
        async setReconstructionStatus() { return true },
        async failStart() { return false },
        async listReady() { return [] },
        async active() { return null },
        async requestCancel() { return null },
      },
      supervisor: {
        async subscribe() {
          subscriptions++
          await connecting
          return {
            next(signal: AbortSignal) {
              return new Promise<null>(resolve => {
                if (signal.aborted) resolve(null)
                else signal.addEventListener('abort', () => resolve(null), { once: true })
              })
            },
            async close() { closed++ },
          }
        },
        async publish() { return 0 },
        diagnose() {},
      },
    })
    const work = [runtime.start(), runtime.start(), runtime.close()]
    release()
    await Promise.all(work)
    expect({ subscriptions, closed }).toEqual({ subscriptions: 1, closed: 1 })
    await runtime.start()
    await runtime.close()
    expect({ subscriptions, closed }).toEqual({ subscriptions: 2, closed: 2 })
  })
})
