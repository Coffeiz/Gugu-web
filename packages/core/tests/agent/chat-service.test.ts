import { describe, expect, it, vi } from 'vitest'
import { createAgentChatService } from '../../src/agent/index.js'
import type { AgentChatServicePorts } from '../../src/agent/index.js'

const identity = { ownerId: 'owner-synthetic', sessionId: '42', runId: 'run-synthetic' }

function ports(overrides: Partial<AgentChatServicePorts<string, { client_message_id?: string }>> = {}) {
  const kick = vi.fn(async () => {})
  const notify = vi.fn(async () => {})
  const base: AgentChatServicePorts<string, { client_message_id?: string }> = {
    cancellation: { async request() {}, async notify() {} },
    async prepare() { return { identity, userMessageId: 17 } },
    async active() { return null },
    events: {
      async open() {
        return (async function* () {
          yield { identity, id: 'event-1', sequence: 1, round: 1, type: 'final', payload: { status: 'completed' } }
        })()
      },
      async notify() {},
    },
    async project(event) { return [{ type: 'projected', sequence: event.sequence }] },
    async failStart() {},
    dispatch: {
      kick,
      notify,
      diagnose() {},
      async requestCancel() { return identity },
    },
  }
  return { value: { ...base, ...overrides }, kick, notify }
}

describe('Core Agent Chat service', () => {
  it('starts an owner-bound run, preserves the client message id, and projects persisted events', async () => {
    const fixture = ports()
    const service = createAgentChatService(fixture.value)
    const stream = await service.start(identity.ownerId, { client_message_id: 'client-synthetic' }, 'web')

    expect(fixture.notify).toHaveBeenCalledOnce()
    expect(fixture.kick).toHaveBeenCalledWith(identity.ownerId, identity.sessionId)
    expect(await Array.fromAsync(stream)).toEqual([
      { type: 'session_id', session_id: 42, user_message_id: 17, client_message_id: 'client-synthetic' },
      { type: 'projected', sequence: 1 },
    ])
  })

  it('returns idle on resume without an active run and rejects a run owned by another account', async () => {
    const fixture = ports({ active: async () => ({ identity: null }) })
    const service = createAgentChatService(fixture.value)
    const idle = await service.resume(identity.ownerId, 42)
    expect(idle && await Array.fromAsync(idle)).toEqual([{ type: 'done', idle: true }])

    fixture.value.active = async () => ({ identity: { ...identity, ownerId: 'other-owner' } })
    await expect(service.resume(identity.ownerId, 42)).rejects.toThrow('运行身份不匹配')
  })

  it('requests cancellation only for the owner-bound active dispatch lease', async () => {
    const requestCancel = vi.fn(async () => identity)
    const cancellation = vi.fn(async () => {})
    const fixture = ports({
      active: async () => ({ identity }),
      cancellation: { request: cancellation, async notify() {} },
      dispatch: { ...ports().value.dispatch!, requestCancel },
    })
    const result = await createAgentChatService(fixture.value).cancel(identity.ownerId, 42)

    expect(requestCancel).toHaveBeenCalledWith(identity.ownerId, identity.sessionId)
    expect(cancellation).toHaveBeenCalledWith(identity)
    expect(result).toEqual({ ok: true, active: true, recovered: false, cancelled_locally: false, outcome: 'requested' })
  })
})
