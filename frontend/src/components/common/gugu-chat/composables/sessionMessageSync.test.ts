import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ChatMessage } from '../chatTypes'
import { agentApi } from '@/services/api'
import { createSessionMessageSynchronizer, mergeSessionMessageDelta } from './sessionMessageSync'

vi.mock('@/services/api', () => ({ agentApi: { getMessages: vi.fn() } }))

const message = (id: number, key: string, text: string): ChatMessage => ({
  id, role: 'ai', text, time: '', _syncKey: key,
})

describe('mergeSessionMessageDelta', () => {
  it('appends unseen persisted messages without duplicating local bubbles', () => {
    const current = [message(1, 'message:10', 'hello')]
    const merged = mergeSessionMessageDelta(current, [
      message(2, 'message:10', 'hello'),
      message(3, 'message:11', 'world'),
    ])

    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ id: 1, text: 'hello' })
    expect(merged[1]).toMatchObject({ id: 3, text: 'world' })
  })

  it('updates an existing tool/timeline event when its persisted state changes', () => {
    const current = [message(4, 'tool:call-1', 'running')]
    const merged = mergeSessionMessageDelta(current, [message(5, 'tool:call-1', 'success')])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: 4, text: 'success' })
  })

  it('preserves unkeyed ephemeral messages', () => {
    const ephemeral = message(1, '', 'streaming')
    const merged = mergeSessionMessageDelta([ephemeral], [message(2, 'message:2', 'saved')])
    expect(merged).toEqual([ephemeral, message(2, 'message:2', 'saved')])
  })
})

describe('session message refresh', () => {
  beforeEach(() => vi.mocked(agentApi.getMessages).mockReset())

  it('maps persisted ids into stable keys and fetches only after the current cursor', async () => {
    const sessionId = ref<number | null>(12)
    const messages = ref<ChatMessage[]>([message(1, 'message:40', 'already shown')])
    vi.mocked(agentApi.getMessages).mockResolvedValue({
      messages: [{ id: 40, role: 'user', content: 'already shown', createdAt: '2026-09-21T00:00:00Z' },
        { id: 41, role: 'user', content: 'new', createdAt: '2026-09-21T00:01:00Z' }],
      timelineEvents: [], toolEvents: [], pagination: { newestId: 41 },
    } as any)
    const sync = createSessionMessageSynchronizer({
      messages, sessionId, mkid: (() => { let id = 10; return () => id++ })(),
      resolveSpeaker: role => ({ role }), scrollBottom: async () => {},
    })
    sync.setCursor(12, 40)

    await sync.refresh(12)

    expect(agentApi.getMessages).toHaveBeenCalledWith('12', 40, 200)
    expect(messages.value.map(item => item.text)).toEqual(['already shown', 'new'])
    expect(messages.value[1]._syncKey).toBe('message:41')
  })

  it('does not apply a response after the active session changed', async () => {
    const sessionId = ref<number | null>(12)
    const messages = ref<ChatMessage[]>([])
    let resolveRequest!: (value: any) => void
    vi.mocked(agentApi.getMessages).mockReturnValue(new Promise(resolve => { resolveRequest = resolve }))
    const sync = createSessionMessageSynchronizer({
      messages, sessionId, mkid: () => 2,
      resolveSpeaker: role => ({ role }), scrollBottom: async () => {},
    })
    const pending = sync.refresh(12)
    sessionId.value = 13
    resolveRequest({ messages: [{ id: 1, role: 'user', content: 'stale', createdAt: '' }], pagination: { newestId: 1 } })
    await pending
    expect(messages.value).toEqual([])
  })
})
