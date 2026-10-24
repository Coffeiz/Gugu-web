import { effectScope, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useChatSessions } from '@/components/common/gugu-chat/composables/useChatSessions'
import { agentApi } from '@/services/api'
import type { ChatMessage, ChatSession } from '@/components/common/gugu-chat/chatTypes'

vi.mock('@/services/api', () => ({
  agentApi: {
    getMessages: vi.fn(),
    listSessionInteractions: vi.fn(),
  },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function createSessionManager() {
  const sessionId = ref<number | null>(null)
  const messages = ref<ChatMessage[]>([])
  const sessionList = ref<ChatSession[]>([])
  const streaming = ref(false)
  const resumeStream = vi.fn(async () => {})
  const scope = effectScope()
  const sessions = scope.run(() => {
    let generation = 0
    return useChatSessions({
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
      drainPendingQueue: async () => {},
      clearStatus: () => {},
      setStatus: () => {},
      contextCompactingItem: () => ({ kind: 'hide' as const }),
      onContentReset: () => {},
      onCaptureBaseScrollH: () => {},
      scrollBottom: async () => {},
      waitForStableScrollLayout: async () => {},
      waitForSessionSettlement: async () => {},
      shouldFollowBottom: () => false,
      setCachedHistoryVisible: () => {},
      setSessionSettling: () => {},
    })
  })!
  return { scope, sessionId, messages, sessions, sessionList, streaming, resumeStream }
}

describe('会话加载代次', () => {
  afterEach(() => vi.resetAllMocks())

  it('启动恢复 A 等待交互卡片期间切到 B 后，A 不能覆盖 B 的消息', async () => {
    const interactions = deferred<{ items: [] }>()
    const response = (content: string) => ({
      messages: [{ id: 1, role: 'user', content, createdAt: '2026-10-15T00:00:00Z' }],
      timelineEvents: [], pagination: { newestId: 1 }, active: false,
    } as any)
    vi.mocked(agentApi.getMessages).mockImplementation(async (id) => response(`会话 ${id === '101' ? 'A' : 'B'}`))
    vi.mocked(agentApi.listSessionInteractions).mockImplementation((id) =>
      id === '101' ? interactions.promise as any : Promise.resolve({ items: [] }),
    )

    const { scope, sessionId, messages, sessions } = createSessionManager()

    const restoreA = sessions.loadSession(101, true)
    await vi.waitFor(() => expect(agentApi.listSessionInteractions).toHaveBeenCalledWith('101'))

    // B 的导航使 A 的视图代次失效，并完整加载 B。
    await expect(sessions.loadSession(202, true)).resolves.toBe('loaded')
    expect(sessionId.value).toBe(202)
    expect(messages.value.map((message) => message.text)).toEqual(['会话 B'])

    interactions.resolve({ items: [] })
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

  it('切回时以服务端终态覆盖缓存运行态，不续接已结束会话也不保留动画', async () => {
    const { scope, sessionId, messages, sessions, sessionList, streaming, resumeStream } = createSessionManager()
    sessionList.value = [
      { id: 101, title: '运行中的缓存会话', isRunning: true },
      { id: 202, title: '另一个会话', isRunning: false },
    ]
    vi.mocked(agentApi.getMessages).mockImplementation(async (id) => ({
      messages: [{ id: Number(id), role: 'user', content: '会话内容', createdAt: '2026-10-15T00:00:00Z' }],
      timelineEvents: [], pagination: { newestId: Number(id) }, active: id === '101' && sessionId.value == null,
    } as any))
    vi.mocked(agentApi.listSessionInteractions).mockResolvedValue({ items: [] } as any)

    await sessions.loadSession(101)
    messages.value = [{ id: 7, dbId: 7, role: 'ai', text: '缓存中的回复', time: '12:00' }]
    streaming.value = true
    await sessions.loadSession(202)
    streaming.value = false
    resumeStream.mockClear()

    // 会话 101 的内存快照仍记着曾在运行；服务器已返回 active=false。
    await sessions.loadSession(101)

    expect(sessionList.value.find(session => session.id === 101)?.isRunning).toBe(false)
    expect(resumeStream).toHaveBeenCalledTimes(0)
    scope.stop()
  })
})
