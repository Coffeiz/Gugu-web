import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ChatMessage } from '@/components/common/gugu-chat/chatTypes'
import { agentApi } from '@/services/api'
import { createSessionMessageSynchronizer, ensureSessionMessageLoaded, findLatestPersistedAssistant, mapSessionMessageDelta, mergeSessionMessageDelta } from '@/components/common/gugu-chat/composables/sessionMessageSync'

vi.mock('@/services/api', () => ({ agentApi: { getMessages: vi.fn(), getMessagesBefore: vi.fn() } }))

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

  it('reconciles a recovered timeline reply with its later incremental event', () => {
    const data = {
      messages: [],
      timelineEvents: [{ id: '250810:0', kind: 'assistant', text: 'persisted final reply',
        createdAt: '2026-10-15T03:17:00Z', timelineOrder: 250810000 }],
    }
    const recovered = findLatestPersistedAssistant(data)
    expect(recovered?.syncKey).toBe('timeline:250810:0')

    const current: ChatMessage[] = [{
      id: 1, dbId: 250810, role: 'ai', text: recovered!.text, time: '',
      _syncKey: recovered!.syncKey,
    }]
    const incoming = mapSessionMessageDelta(data, () => 2, role => ({ role }))
    const merged = mergeSessionMessageDelta(current, incoming)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: 1, dbId: 250810, text: 'persisted final reply' })
  })

  it('does not recover an old persisted assistant reply as the current turn', () => {
    const result = findLatestPersistedAssistant({
      messages: [],
      timelineEvents: [{ id: 'old', kind: 'assistant', text: 'old reply',
        createdAt: '2026-10-14T03:17:00Z' }],
    }, Date.parse('2026-10-15T03:00:00Z'))

    expect(result).toBeNull()
  })
})

describe('session message refresh', () => {
  beforeEach(() => {
    vi.mocked(agentApi.getMessages).mockReset()
    vi.mocked(agentApi.getMessagesBefore).mockReset()
  })

  it('maps persisted ids into stable keys and fetches only after the current cursor', async () => {
    const sessionId = ref<number | null>(12)
    const messages = ref<ChatMessage[]>([message(1, 'message:40', 'already shown')])
    vi.mocked(agentApi.getMessages).mockResolvedValue({
      messages: [{ id: 40, role: 'user', content: 'already shown', createdAt: '2026-09-21T00:00:00Z',
        runOutcome: { status: 'interrupted', errorCode: 'cancelled' } },
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
    expect(messages.value[0].runOutcome?.status).toBe('interrupted')
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

describe('search result message loading', () => {
  it('loads a bounded page around an older hit and makes it available for navigation', async () => {
    const messages = ref<ChatMessage[]>([{
      ...message(1, 'message:500', 'latest'), dbId: 500,
      _createdAt: '2026-09-02T00:00:00Z', _timelineOrder: 500000,
    }])
    vi.mocked(agentApi.getMessagesBefore).mockResolvedValue({
      messages: [{ id: 17, role: 'user', content: 'older hit', createdAt: '2026-09-01T00:00:00Z' }],
      timelineEvents: [], toolEvents: [],
    } as any)

    const found = await ensureSessionMessageLoaded({
      sessionId: 12,
      messageId: 17,
      messages,
      mkid: () => 2,
      resolveSpeaker: role => ({ role }),
    })

    expect(found).toBe(true)
    expect(agentApi.getMessagesBefore).toHaveBeenCalledWith('12', 18, 200)
    expect(messages.value.map(item => item.dbId)).toEqual([17, 500])
    expect(messages.value.find(item => item.dbId === 17)?.text).toBe('older hit')
  })

  it('does not claim a search hit was loaded when it is outside the owned session page', async () => {
    const messages = ref<ChatMessage[]>([])
    vi.mocked(agentApi.getMessagesBefore).mockResolvedValue({ messages: [], timelineEvents: [], toolEvents: [] } as any)

    const found = await ensureSessionMessageLoaded({
      sessionId: 12,
      messageId: 99,
      messages,
      mkid: () => 1,
      resolveSpeaker: role => ({ role }),
    })

    expect(found).toBe(false)
    expect(messages.value).toEqual([])
  })

  it('discards a history page if the user switches sessions before it returns', async () => {
    const messages = ref<ChatMessage[]>([])
    let finish!: (value: any) => void
    vi.mocked(agentApi.getMessagesBefore).mockReturnValue(new Promise(resolve => { finish = resolve }) as any)
    const activeSession = ref(12)
    const loading = ensureSessionMessageLoaded({
      sessionId: 12,
      messageId: 17,
      messages,
      mkid: () => 1,
      resolveSpeaker: role => ({ role }),
      isCurrent: () => activeSession.value === 12,
    })
    activeSession.value = 13
    finish({
      messages: [{ id: 17, role: 'user', content: 'stale session hit', createdAt: '2026-09-01T00:00:00Z' }],
      timelineEvents: [], toolEvents: [],
    })

    await expect(loading).resolves.toBe(false)
    expect(messages.value).toEqual([])
  })
})
