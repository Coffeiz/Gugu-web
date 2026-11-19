import assert from 'node:assert/strict'
import test from 'node:test'
import type { RunIdentity, ToolCall, ToolResult } from '@gugu/core/agent'
import { createWebAgentToolPorts } from '../../src/modules/agent/run/reconstruct.js'

const lease = { identity: { ownerId: 'owner-a', sessionId: '17', runId: 'run-a' } }
const prepIdentity = { ownerId: 'owner-a', subject: { kind: 'session' as const, id: '17' }, workspaceId: null }

test('Web Run ToolPort dispatch/reconcile/plan are bound to the complete lease identity', async () => {
  const calls: string[] = []
  const success: ToolResult = { kind: 'completed', value: { ok: true }, successful: true, mutated: false, executed: false }
  const registry = {
    async capabilities(identity: RunIdentity) { calls.push(`capabilities:${identity.runId}`); return [] },
    tools: {
      async plan(_calls: readonly ToolCall[], identity: RunIdentity) {
        calls.push(`plan:${identity.runId}`)
        return { mode: 'serial' as const }
      },
      async dispatch(_call: ToolCall, scope: { identity: RunIdentity }) {
        calls.push(`dispatch:${scope.identity.runId}`)
        return success
      },
      async reconcile(_call: ToolCall, identity: RunIdentity & { roundId: string }) {
        calls.push(`reconcile:${identity.runId}`)
        return success
      },
    },
  }
  const ports = createWebAgentToolPorts(lease, registry as never, {
    async configuration() { return { identity: prepIdentity, source: 'web', toolNames: [] } },
    capabilities: {
      workspaceSupported: false,
      filterConfigured: async names => names,
      shellPolicy: async () => ({ allowed: false, needsConfirmation: false }),
      shellState: async () => null,
      appendShellProtocol: value => value,
      catalog: async () => null,
    },
    formatPrefix: () => [],
  })
  const call: ToolCall = { id: 'identity-check', name: 'search_conversations', input: {} }
  const signal = new AbortController().signal
  const identities = [
    { ...lease.identity, ownerId: 'owner-b' },
    { ...lease.identity, sessionId: '18' },
    { ...lease.identity, runId: 'run-b' },
  ]
  for (const identity of identities) {
    const denied = await ports.tools.dispatch(call, { identity, roundId: 'round-1', signal,
      execute: async () => { throw new Error('read-only tool must not execute') }, resolution: null })
    assert.equal(denied.kind, 'completed')
    assert.equal(denied.kind === 'completed' && denied.successful, false)
    assert.deepEqual(await ports.tools.reconcile(call, { ...identity, roundId: 'round-1' }), { kind: 'unknown' })
  }
  await assert.rejects(ports.tools.plan?.([call], { ...lease.identity, runId: 'run-b' }))
  assert.deepEqual(calls, [])

  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(ports.tools.dispatch(call, { identity: identities[0]!, roundId: 'round-1', signal: cancelled.signal,
    execute: async () => { throw new Error('read-only tool must not execute') }, resolution: null }), { name: 'AbortError' })
  assert.deepEqual(calls, [])

  assert.deepEqual(await ports.tools.dispatch(call, { identity: lease.identity, roundId: 'round-1', signal,
    execute: async () => { throw new Error('read-only tool must not execute') }, resolution: null }), success)
  assert.deepEqual(await ports.tools.reconcile(call, { ...lease.identity, roundId: 'round-1' }), success)
  assert.deepEqual(await ports.tools.plan?.([call], lease.identity), { mode: 'serial' })
  assert.deepEqual(calls, ['dispatch:run-a', 'reconcile:run-a', 'plan:run-a'])
})
