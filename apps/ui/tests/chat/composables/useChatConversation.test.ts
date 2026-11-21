import { createPinia } from 'pinia'
import { createApp, nextTick, ref } from 'vue'
import { expect, it, vi } from 'vitest'
import { encodeAgentChatSse } from '@gugu/core/agent/chat-sse'
import { agentApi } from '@/services/api'
import { webChatSessionAccess } from '@web/chat/sessionAccess'
import { useLiveStore } from '@/stores/live'
import { useChatConversation } from '@/components/common/gugu-chat/composables/useChatConversation'

it('桌面忽略 Web 会话通知，并在旧流结束后根据平台通知补读 IM 消息', async () => {
  let notify: ((id?: number) => void) | undefined
  let closeOldStream!: () => void
  const oldStream = new ReadableStream<Uint8Array>({
    start(controller) { closeOldStream = () => controller.close() },
  })
  const resumedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(encodeAgentChatSse({ type: 'done', run_id: 'active-run' })))
      controller.close()
    },
  })
  const observedMessages: string[][] = []
  const resume = vi.fn().mockReturnValueOnce(oldStream).mockImplementationOnce(() => {
    observedMessages.push(chat.messages.value.filter(message => message.role === 'user').map(message => message.text))
    return resumedStream
  })
  const readRunState = vi.fn(async () => ({ active: true, runId: 'active-run' }))
  const listSessions = vi.fn(async () => [])
  const readHistory = async () => ({
    messages: readRunState.mock.calls.length
      ? [{ id: 17, role: 'user', content: '合成 IM 消息', createdAt: '2026-01-01T00:00:00Z', runId: 'active-run' }]
      : [],
    active: false,
  })
  const noOp = () => {}
  const noOpAsync = async () => {}
  let chat!: ReturnType<typeof useChatConversation>
  const pinia = createPinia()
  const app = createApp({
    setup() {
      chat = useChatConversation({
        composerRef: ref(null), messageListRef: ref(null), pendingAtt: ref([]),
        refreshAfterTools: noOpAsync, loadQuota: noOp, playIncomingMessageSfx: noOp,
        onContentReset: noOp, onCaptureBaseScrollH: noOp, onSyncSmallH: noOp,
        sessionAccess: {
          readHistory, readRunState, deleteSession: noOpAsync, renameSession: noOpAsync,
          listSessions, readPendingQueue: async () => ({ items: [] }),
          subscribeRunChanges(listener) { notify = listener; return () => { notify = undefined } },
          queue: { replace: noOpAsync, patch: noOpAsync, claim: async () => ({ claim_token: null }), release: noOpAsync },
          run: {
            readHistory, readState: async () => ({ status: 'running', runId: 'active-run' }),
            createSession: async () => ({ id: 42 }),
            cancel: async () => ({ outcome: 'already_completed' }),
            send: () => { throw new Error('续看不应创建新运行') },
            resume,
          },
        },
      })
      return () => null
    },
  }).use(pinia)
  app.mount(document.createElement('div'))
  try {
    await chat.loadSession(42)
    const live = useLiveStore(pinia)
    live.agentRunEvent = { protocol_version: 'live-event-v1', type: 'agent.run.changed',
      event_id: 'synthetic-web-event', session_id: 42, run_id: 'web-run', status: 'running',
      created_at: '2026-01-01T00:00:00Z', _t: 1 }
    await nextTick()
    expect(resume).not.toHaveBeenCalled()
    expect(listSessions).not.toHaveBeenCalled()
    const observing = chat.resumeStream(42, 'active-run')
    notify?.(42)
    await vi.waitFor(() => expect(listSessions).toHaveBeenCalledOnce())
    expect(resume).toHaveBeenCalledOnce()
    expect(readRunState).not.toHaveBeenCalled()

    closeOldStream()
    await observing
    await vi.waitFor(() => expect(readRunState).toHaveBeenCalledExactlyOnceWith(42))
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(2))
    expect(observedMessages).toEqual([['合成 IM 消息']])
    expect(resume).toHaveBeenLastCalledWith(42, 'active-run', expect.any(AbortSignal))
  } finally {
    app.unmount()
  }
})

it('Web 接入会话接口后仍补读历史并续接实时运行', async () => {
  const readMessages = vi.spyOn(agentApi, 'getMessages').mockResolvedValue({
    messages: [],
    active: false,
  })
  const listSessions = vi.fn(async () => [])
  const resume = vi.fn(async () => new Response(encodeAgentChatSse({ type: 'done', run_id: 'web-run' })))
  const noOp = () => {}
  const noOpAsync = async () => {}
  const pinia = createPinia()
  let chat!: ReturnType<typeof useChatConversation>
  const app = createApp({
    setup() {
      chat = useChatConversation({
        composerRef: ref(null), messageListRef: ref(null), pendingAtt: ref([]),
        refreshAfterTools: noOpAsync, loadQuota: noOp, playIncomingMessageSfx: noOp,
        onContentReset: noOp, onCaptureBaseScrollH: noOp, onSyncSmallH: noOp,
        sessionAccess: { ...webChatSessionAccess, listSessions },
        httpStream: { resume, send: async () => { throw new Error('续接不应发送新消息') } },
      })
      return () => null
    },
  }).use(pinia)
  app.mount(document.createElement('div'))
  try {
    await chat.loadSession(42)
    expect(readMessages).toHaveBeenCalledWith(42, { restoreInteractions: true })
    readMessages.mockResolvedValue({
      messages: [{ id: 17, role: 'user', content: '合成 Web 消息', runId: 'web-run', createdAt: '2026-01-01T00:00:00Z' }],
      pagination: { newestId: 17 },
    })

    useLiveStore(pinia).agentRunEvent = {
      protocol_version: 'live-event-v1', type: 'agent.run.changed', event_id: 'synthetic-web-event',
      session_id: 42, run_id: 'web-run', status: 'running', created_at: '2026-01-01T00:00:00Z', _t: 1,
    }

    await vi.waitFor(() => expect(resume).toHaveBeenCalledExactlyOnceWith(42, 'web-run', expect.any(AbortSignal)))
    expect(readMessages).toHaveBeenCalledWith(42, { afterId: 0, limit: 200 })
    expect(chat.messages.value.some(message => message.role === 'user' && message.text === '合成 Web 消息')).toBe(true)
    expect(listSessions).toHaveBeenCalled()
    await vi.waitFor(() => expect(chat.streaming.value).toBe(false))
  } finally {
    app.unmount()
    readMessages.mockRestore()
  }
})
