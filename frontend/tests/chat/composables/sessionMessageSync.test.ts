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
      timelineEvents: [{ id: '250810:0', messageId: 250810, kind: 'assistant', text: 'persisted final reply',
        runId: 'run-current', roundId: 'round-current',
        createdAt: '2026-10-15T03:17:00Z', timelineOrder: 250810000 }],
    }
    const recovered = findLatestPersistedAssistant(data, 'run-current')
    expect(recovered?.syncKey).toBe('assistant-round:run-current:round-current')

    const current: ChatMessage[] = [{
      id: 1, dbId: 250810, role: 'ai', text: recovered!.text, time: '',
      _syncKey: recovered!.syncKey,
    }]
    const incoming = mapSessionMessageDelta(data, () => 2, role => ({ role }))
    const merged = mergeSessionMessageDelta(current, incoming)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: 1, dbId: 250810, text: 'persisted final reply' })
  })

  it('实时回复与同一回合持久化副本合并为一个气泡并保留流式正文', () => {
    const current: ChatMessage[] = [{
      id: 1, role: 'ai', text: '实时回答正文', time: '', streaming: true,
      runId: 'core-run-1', roundId: 'round-2', _syncKey: 'assistant-round:core-run-1:round-2',
    }]
    const incoming = mapSessionMessageDelta({
      messages: [{ id: 91, role: 'assistant', content: '已持久化回答正文', createdAt: '2026-10-15T03:17:00Z',
        runId: 'core-run-1', roundId: 'round-2' }],
      timelineEvents: [], toolEvents: [],
    }, () => 2, role => ({ role: role === 'assistant' ? 'ai' : role }))

    const merged = mergeSessionMessageDelta(current, incoming)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 1, dbId: 91, text: '实时回答正文', streaming: true,
      _syncKey: 'assistant-round:core-run-1:round-2',
    })
  })

  it('持久化的正文和时间线事件使用相同的回合身份', () => {
    const incoming = mapSessionMessageDelta({ messages: [
      { id: 91, role: 'assistant', content: '已有回答', createdAt: '', runId: 'run-a', roundId: 'r1' },
    ], timelineEvents: [{ id: 'timeline-91', kind: 'assistant', text: '已有回答', createdAt: '',
      runId: 'run-a', roundId: 'r1' }] }, () => 2, role => ({ role: role === 'assistant' ? 'ai' : role }))
    expect(incoming).toHaveLength(2)
    expect(incoming[0]?._syncKey).toBe('assistant-round:run-a:r1')
    expect(incoming[1]?._syncKey).toBe('assistant-round:run-a:r1')
  })

  it('首屏历史与增量恢复对同一持久化事件生成相同身份键', () => {
    const history = {
      messages: [{ id: 91, role: 'assistant', content: '已有回答', createdAt: '', runId: 'run-a', roundId: 'r1' }],
      timelineEvents: [{ id: 'timeline-91:0', messageId: 91, kind: 'assistant', text: '已有回答',
        createdAt: '', runId: 'run-a', roundId: 'r1' }],
      toolEvents: [{ id: 'tool:call-1', toolCallId: 'call-1', runId: 'run-a', roundId: 'r1', createdAt: '' }],
    }
    const initial = mapSessionMessageDelta(history, () => 1, role => ({ role: role === 'assistant' ? 'ai' : role }))
    const refreshed = mapSessionMessageDelta(history, () => 2, role => ({ role: role === 'assistant' ? 'ai' : role }))

    expect(initial.map(item => item._syncKey)).toEqual(refreshed.map(item => item._syncKey))
    expect(initial.map(item => item._syncKey)).toEqual([
      'assistant-round:run-a:r1', 'assistant-round:run-a:r1', 'tool-call:["run-a","r1","call-1"]',
    ])
  })

  it('工具调用键包含 run 和 round，旧事件则使用持久化事件 ID', () => {
    const incoming = mapSessionMessageDelta({
      messages: [], timelineEvents: [],
      toolEvents: [
        { id: 'event-a', toolCallId: 'call-1', runId: 'run-a', roundId: 'r1', createdAt: '' },
        { id: 'event-b', toolCallId: 'call-1', runId: 'run-b', roundId: 'r1', createdAt: '' },
        { id: 'legacy-a', toolCallId: 'call-1', createdAt: '' },
        { id: 'legacy-b', toolCallId: 'call-1', createdAt: '' },
      ],
    }, () => 1, role => ({ role }))

    expect(incoming.map(item => item._syncKey)).toEqual([
      'tool-call:["run-a","r1","call-1"]', 'tool-call:["run-b","r1","call-1"]',
      'tool:legacy-a', 'tool:legacy-b',
    ])
    expect(mergeSessionMessageDelta([], incoming)).toHaveLength(4)
  })

  it('保留不同 run/round 中正文相同的合法回答', () => {
    const current: ChatMessage[] = [{
      id: 1, role: 'ai', text: '收到', time: '', runId: 'run-1', roundId: 'round-1',
      _syncKey: 'assistant-round:run-1:round-1',
    }]
    const incoming = mapSessionMessageDelta({
      messages: [{ id: 92, role: 'assistant', content: '收到', createdAt: '2026-10-15T03:17:00Z',
        runId: 'run-2', roundId: 'round-1' }],
      timelineEvents: [], toolEvents: [],
    }, () => 2, role => ({ role: role === 'assistant' ? 'ai' : role }))

    expect(mergeSessionMessageDelta(current, incoming)).toHaveLength(2)
  })

  it('不按时间猜测归属：排除上一轮及队列下一轮的回复', () => {
    const result = findLatestPersistedAssistant({
      messages: [],
      timelineEvents: [{ id: 'old', kind: 'assistant', text: 'old reply',
        runId: 'run-old', createdAt: '2026-10-15T03:17:00Z' },
        { id: 'next', kind: 'assistant', text: 'next reply', runId: 'run-next', createdAt: '2026-10-15T03:18:00Z' }],
    }, 'run-current')

    expect(result).toBeNull()
  })

  it('当前 run 的恢复不会选中时间更新的队列 run', () => {
    const result = findLatestPersistedAssistant({ timelineEvents: [
      { id: '302:0', kind: 'assistant', text: '当前回答', runId: 'run-current', createdAt: '2026-10-15T08:42:01Z' },
      { id: '305:0', kind: 'assistant', text: '下一轮回答', runId: 'run-next', createdAt: '2026-10-15T08:42:06Z' },
    ] }, 'run-current')
    expect(result?.text).toBe('当前回答')
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
