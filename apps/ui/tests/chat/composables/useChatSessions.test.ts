import { effectScope, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useChatSessions, type ChatSessionHistoryAccess } from '@/components/common/gugu-chat/composables/useChatSessions'
import { agentApi } from '@/services/api'
import type { SessionScrollAnchor } from '@/components/common/gugu-chat/composables/sessionScrollLayout'
import type { ChatMessage, ChatSession } from '@/components/common/gugu-chat/chatTypes'

vi.mock('@/services/api', () => ({
  agentApi: {
    getMessages: vi.fn(),
  },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function createSessionManager(historyAccess?: ChatSessionHistoryAccess) {
  const sessionId = ref<number | null>(null)
  const messages = ref<ChatMessage[]>([])
  const sessionList = ref<ChatSession[]>([])
  const streaming = ref(false)
  const sessionSettling = ref(false)
  const resumeStream = vi.fn(async () => {})
  const restoreScrollPosition = vi.fn(async (_anchor: SessionScrollAnchor | null) => {})
  const captureScrollAnchor = vi.fn<() => SessionScrollAnchor | null>()
  const onHistoryLoaded = vi.fn()
  const clearStatus = vi.fn()
  const drainPendingQueue = vi.fn(async () => {})
  const scope = effectScope()
  const sessions = scope.run(() => {
    let generation = 0
    return useChatSessions({
      historyAccess, onHistoryLoaded,
      messages,
      mkid: () => 1,
      sessionId,
      sessions: sessionList,
      ownerPlatformUserId: ref(null),
      isGroupSession: ref(false),
      resolveSpeaker: (role) => ({ role: role === 'assistant' ? 'ai' : 'user' }),
      bumpViewGeneration: () => ++generation,
      getViewGeneration: () => generation,
      composerRef: ref(null),
      abortCtrl: ref(null),
      streaming,
      resumeStream,
      resetSessionTurn: () => {},
      clearPendingQueue: () => {},
      restorePendingQueue: () => {},
      drainPendingQueue,
      clearStatus,
      setStatus: () => {},
      thinkingItem: () => ({ kind: 'dots' as const }),
      contextCompactingItem: () => ({ kind: 'hide' as const }),
      onContentReset: () => {},
      onCaptureBaseScrollH: () => {},
      scrollBottom: async () => {},
      captureScrollAnchor, restoreScrollPosition,
      waitForSessionSettlement: async () => {},
      shouldFollowBottom: () => false,
      setSessionSettling: (value) => { sessionSettling.value = value },
    })
  })!
  return { scope, sessionId, messages, sessions, onHistoryLoaded, clearStatus, drainPendingQueue, sessionList, streaming, resumeStream, captureScrollAnchor, restoreScrollPosition, sessionSettling }
}

describe('会话加载代次', () => {
  afterEach(() => vi.resetAllMocks())

  it('桌面上下文整理结束后通过本机状态收起提示', async () => {
    vi.useFakeTimers()
    const readExecutionState = vi.fn(async () => 'idle')
    const { scope, sessions, clearStatus, drainPendingQueue } = createSessionManager({
      readHistory: vi.fn(async () => ({ messages: [], active: false, executionState: 'baseline_updating' })),
      readExecutionState, deleteSession: vi.fn(), renameSession: vi.fn(),
    })
    try {
      await sessions.loadSession(7)
      clearStatus.mockClear()
      expect(drainPendingQueue).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(4000)
      expect(readExecutionState).toHaveBeenCalledWith(7)
      expect(clearStatus).toHaveBeenCalledOnce()
      expect(drainPendingQueue).toHaveBeenCalledOnce()
    } finally {
      scope.stop()
      vi.useRealTimers()
    }
  })

  it('桌面补读跨页消息时追到现有历史并保留旧分页游标', async () => {
    const page = (ids: number[], oldestId: number) => ({
      messages: ids.map(id => ({ id, role: 'user', content: String(id), createdAt: '2026-10-15T00:00:00Z' })),
      pagination: { hasMore: true, oldestId },
    })
    const readHistory = vi.fn()
      .mockResolvedValueOnce(page([10, 11], 3))
      .mockResolvedValueOnce(page([15, 16], 8))
      .mockResolvedValueOnce(page([13, 14], 6))
      .mockResolvedValueOnce(page([11, 12], 4))
    const { scope, messages, sessions, onHistoryLoaded } = createSessionManager({
      readHistory, deleteSession: vi.fn(), renameSession: vi.fn(),
    })
    try {
      await expect(sessions.loadSession(7)).resolves.toBe('loaded')
      await sessions.refreshSessionMessages(7)
      expect(readHistory.mock.calls).toEqual([[7, undefined], [7, undefined], [7, 8], [7, 6]])
      expect(messages.value.map(message => message.dbId)).toEqual([10, 11, 12, 13, 14, 15, 16])
      expect(onHistoryLoaded.mock.calls).toEqual([[{ hasMore: true, oldestId: 3 }]])
    } finally {
      scope.stop()
    }
  })

  it('切回桌面缓存会话时补齐离开期间跨页写入的消息', async () => {
    const page = (ids: number[], oldestId: number, hasMore = true) => ({
      messages: ids.map(id => ({ id, role: 'user', content: String(id), createdAt: '2026-10-15T00:00:00Z' })),
      pagination: { hasMore, oldestId },
    })
    const readHistory = vi.fn()
      .mockResolvedValueOnce(page([10, 11], 3))
      .mockResolvedValueOnce(page([20], 1, false))
      .mockResolvedValueOnce(page([14, 15], 7))
      .mockResolvedValueOnce(page([12, 13], 5))
      .mockResolvedValueOnce(page([10, 11], 3))
    const { scope, messages, sessions, onHistoryLoaded } = createSessionManager({
      readHistory, deleteSession: vi.fn(), renameSession: vi.fn(),
    })
    try {
      await sessions.loadSession(7)
      await sessions.loadSession(8)
      await expect(sessions.loadSession(7)).resolves.toBe('loaded')
      expect(messages.value.map(message => message.dbId)).toEqual([10, 11, 12, 13, 14, 15])
      expect(onHistoryLoaded).toHaveBeenLastCalledWith({ hasMore: true, oldestId: 3 })
    } finally {
      scope.stop()
    }
  })

  it('切回缓存会话时，合并历史并校准位置后才展示消息', async () => {
    const { scope, sessions, messages, sessionSettling, captureScrollAnchor, restoreScrollPosition } = createSessionManager()
    const response = (id: number, content: string): Awaited<ReturnType<typeof agentApi.getMessages>> => ({
      messages: [{ id, role: 'user', content, createdAt: '2026-10-15T00:00:00Z' }],
      timelineEvents: [], pagination: { newestId: id }, active: false,
    })
    vi.mocked(agentApi.getMessages).mockImplementation(async (id) => response(Number(id), '缓存消息'))
    try {
      await sessions.loadSession(101)
      expect(restoreScrollPosition).toHaveBeenLastCalledWith(null)
      const anchor = { messageKey: 'message:101', offset: 128 }
      captureScrollAnchor.mockReturnValueOnce(anchor)
      await sessions.loadSession(202)
      const history = deferred<ReturnType<typeof response>>()
      const layout = deferred<void>()
      vi.mocked(agentApi.getMessages).mockReturnValueOnce(history.promise)
      restoreScrollPosition.mockClear()
      restoreScrollPosition.mockReturnValueOnce(layout.promise)
      const loading = sessions.loadSession(101)
      try {
        expect(sessionSettling.value).toBe(true)
        expect(messages.value).toEqual([])
        expect(restoreScrollPosition).not.toHaveBeenCalled()

        history.resolve(response(103, '新消息'))
        await vi.waitFor(() => expect(restoreScrollPosition).toHaveBeenCalledOnce())
        expect(sessionSettling.value).toBe(true)
        expect(restoreScrollPosition).toHaveBeenCalledWith(anchor)
        expect(messages.value.map((message) => message.text)).toEqual(['缓存消息', '新消息'])
      } finally {
        history.resolve(response(103, '新消息'))
        layout.resolve(undefined)
        await loading
      }
      expect(sessionSettling.value).toBe(false)

      captureScrollAnchor.mockReturnValueOnce(null)
      await sessions.loadSession(202)
      await sessions.loadSession(101)
      expect(restoreScrollPosition).toHaveBeenLastCalledWith(null)
    } finally {
      scope.stop()
    }
  })

  it('A 的消息与交互同页在途时切到 B，迟到页不能覆盖 B', async () => {
    const response = (content: string) => ({
      messages: [{ id: 1, role: 'user', content, createdAt: '2026-10-15T00:00:00Z' }],
      timelineEvents: [], pagination: { newestId: 1 }, active: false,
    } as any)
    const pageA = deferred<ReturnType<typeof response>>()
    vi.mocked(agentApi.getMessages).mockImplementation((id) =>
      id === 101 ? pageA.promise : Promise.resolve(response('会话 B')),
    )

    const { scope, sessionId, messages, sessions } = createSessionManager()

    const restoreA = sessions.loadSession(101, true)
    await vi.waitFor(() => expect(agentApi.getMessages).toHaveBeenCalledWith(101, { restoreInteractions: true }))

    // B 的导航使 A 的视图代次失效，并完整加载 B。
    await expect(sessions.loadSession(202, true)).resolves.toBe('loaded')
    expect(sessionId.value).toBe(202)
    expect(messages.value.map((message) => message.text)).toEqual(['会话 B'])

    pageA.resolve({ ...response('会话 A'), interactions: [{ id: 90, title: '旧会话交互卡' }] })
    await expect(restoreA).resolves.toBe('superseded')
    expect(sessionId.value).toBe(202)
    expect(messages.value.map((message) => message.text)).toEqual(['会话 B'])

    scope.stop()
  })

  it('仅会话历史接口明确返回 403 或 404 时判定为不可用', async () => {
    const { scope, sessions } = createSessionManager()
    vi.mocked(agentApi.getMessages).mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }))
      .mockRejectedValueOnce(Object.assign(new Error('server error'), { status: 500 }))

    await expect(sessions.loadSession(101, true)).resolves.toBe('unavailable')
    await expect(sessions.loadSession(202, true)).resolves.toBe('failed')

    scope.stop()
  })

  it('页面刷新后以服务端活跃态续接原会话，即使历史里已有助手回复', async () => {
    const { scope, sessionId, sessions, resumeStream } = createSessionManager()
    sessionId.value = 101
    vi.mocked(agentApi.getMessages).mockResolvedValue({
      messages: [{ id: 1, role: 'assistant', content: '上一轮回复', createdAt: '2026-10-15T00:00:00Z' }],
      timelineEvents: [], pagination: { newestId: 1 }, active: true,
    } as Awaited<ReturnType<typeof agentApi.getMessages>>)

    try {
      await expect(sessions.loadSession(101, true)).resolves.toBe('loaded')
      expect(resumeStream).toHaveBeenCalledExactlyOnceWith(101)
    } finally {
      scope.stop()
    }
  })

  it('切回时以服务端终态覆盖缓存运行态，不续接已结束会话也不保留动画', async () => {
    const { scope, sessionId, messages, sessions, sessionList, streaming, resumeStream, restoreScrollPosition } = createSessionManager()
    sessionList.value = [
      { id: 101, title: '运行中的缓存会话', isRunning: true },
      { id: 202, title: '另一个会话', isRunning: false },
    ]
    vi.mocked(agentApi.getMessages).mockImplementation(async (id) => ({
      messages: [{ id: Number(id), role: 'user', content: '会话内容', createdAt: '2026-10-15T00:00:00Z' }],
      timelineEvents: [], pagination: { newestId: Number(id) }, active: id === 101 && sessionId.value == null,
    } as any))

    await sessions.loadSession(101)
    messages.value = [{ id: 7, dbId: 7, role: 'ai', text: '缓存中的回复', time: '12:00' }]
    streaming.value = true
    await sessions.loadSession(202)
    streaming.value = false
    resumeStream.mockClear()
    restoreScrollPosition.mockClear()

    // 会话 101 的内存快照仍记着曾在运行；服务器已返回 active=false。
    await expect(sessions.loadSession(101)).resolves.toBe('loaded')

    expect(sessionList.value.find(session => session.id === 101)?.isRunning).toBe(false)
    expect(resumeStream).toHaveBeenCalledTimes(0)
    expect(restoreScrollPosition).toHaveBeenCalledOnce()
    scope.stop()
  })
})
