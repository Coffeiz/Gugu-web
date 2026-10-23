import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ChatMessage } from '@/components/common/gugu-chat/chatTypes'
import { agentApi } from '@/services/api'
import { createSessionMessageSynchronizer, ensureSessionMessageLoaded, mapSessionMessageDelta, mergeSessionMessageDelta, replaceRunHistory } from '@/components/common/gugu-chat/composables/sessionMessageSync'

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


  it('展示身份只由 eventId 决定，相同正文不同事件不会合并', () => {
    const events = ['a', 'b'].map(eventId => ({ eventId, kind: 'assistant', text: '收到', runId: 'run-a', roundId: 'r1', createdAt: '2026-01-01T01:00:00Z' }))
    const loaded = mapSessionMessageDelta({ timelineEvents: events }, (() => { let id = 1; return () => id++ })(), role => ({ role }))
    expect(loaded.map(message => message._syncKey)).toEqual(['event:a', 'event:b'])
    expect(mergeSessionMessageDelta(loaded, loaded)).toHaveLength(2)
  })

  it('迟到的旧检查点不能覆盖较新的实时事件', () => {
    const current = [{ ...message(1, 'event:a', '新正文'), _updatedAt: '2026-01-01T01:02:00Z' }]
    const incoming = [{ ...message(2, 'event:a', '旧正文'), _updatedAt: '2026-01-01T01:01:00Z' }]
    expect(mergeSessionMessageDelta(current, incoming)[0].text).toBe('新正文')
  })

  it('run 交接幂等且不会删掉下一轮或无关消息', () => {
    const current = [
      { ...message(1, 'event:a', '实时'), runId: 'run-a', _timelineOrder: 1 },
      { ...message(2, 'event:orphan', '临时'), runId: 'run-a', _timelineOrder: 2 },
      { ...message(3, 'event:b', '下一轮'), runId: 'run-b', _timelineOrder: 3 },
    ]
    const incoming = [{ ...message(9, 'event:a', '历史'), runId: 'run-a', _timelineOrder: 1 }]
    const once = replaceRunHistory(current, incoming, 'run-a')
    expect(replaceRunHistory(once, incoming, 'run-a')).toEqual(once)
    expect(once.map(message => [message.id, message.text])).toEqual([[1, '历史'], [3, '下一轮']])
  })

})

describe('session message refresh', () => {
  beforeEach(() => {
    vi.mocked(agentApi.getMessages).mockReset()
    vi.mocked(agentApi.getMessagesBefore).mockReset()
  })

  it('原位更新的检查点与自增消息增量一起校准', async () => {
    const sessionId = ref<number | null>(12)
    const messages = ref<ChatMessage[]>([message(1, 'message:40', 'already shown')])
    vi.mocked(agentApi.getMessages).mockResolvedValue({
      messages: [{ id: 40, role: 'user', content: 'already shown', createdAt: '2026-09-21T00:00:00Z',
        runOutcome: { status: 'interrupted', errorCode: 'cancelled' } },
        { id: 41, role: 'user', content: 'new', createdAt: '2026-09-21T00:01:00Z' }],
      timelineEvents: [], pagination: { newestId: 41 },
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
      timelineEvents: [],
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
    vi.mocked(agentApi.getMessagesBefore).mockResolvedValue({ messages: [], timelineEvents: [] } as any)

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
      timelineEvents: [],
    })

    await expect(loading).resolves.toBe(false)
    expect(messages.value).toEqual([])
  })
})
