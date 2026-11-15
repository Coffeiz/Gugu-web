import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAgentDispatchSupervisor } from '../../src/domains/agent-sessions/agent-dispatch-supervisor.js'

test('首次订阅失败时仍扫描持久队列并重新订阅', async () => {
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
    async listReady() { scans++; return scans === 1 ? [{ ownerId: 'owner', sessionId: '1' }] : [] },
    async kick(owner, session) { calls.push(`${owner}:${session}`); wake() },
    async publish() { return 0 },
    diagnose(code) { diagnostics.push(code) },
    recoveryIntervalMs: 1000,
  })
  const running = await supervisor.start()
  await consumed
  await running.stop()
  await running.drain()
  assert.deepEqual(calls, ['owner:1'])
  assert.equal(subscriptions, 2)
  assert.equal(closed, 1)
  assert.deepEqual(diagnostics, ['subscription_failed'])
})
