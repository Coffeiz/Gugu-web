import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n'
import { agentApi, trackApi } from '@/services/api'
import { useChatStream } from './useChatStream'
import type { ChatMessage } from '../chatTypes'

function createOptions(messages: ChatMessage[], sessionId = ref<number | null>(42)) {
  return {
    messages: ref(messages),
    mkid: () => 100,
    now: () => '12:00',
    inputText: ref(''),
    inputReferences: ref([]),
    sessionId,
    sessions: ref([]),
    getViewGeneration: () => 0,
    bindNewSessionId: (id: number) => { sessionId.value = id },
    pendingAtt: ref([]),
    composerRef: ref(null),
    setStatus: vi.fn(),
    clearStatus: vi.fn(),
    thinkingItem: () => ({ kind: 'dots' as const }),
    contextCompactingItem: () => ({ kind: 'dots' as const }),
    scrollBottom: vi.fn(async () => {}),
    fetchSessions: vi.fn(async () => {}),
    refreshAfterTools: vi.fn(async () => {}),
    loadQuota: vi.fn(),
    playIncomingMessageSfx: vi.fn(),
  } as unknown as Parameters<typeof useChatStream>[0]
}

describe('useChatStream 停止 run', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('请求取消时保留 SSE，收到取消终态后将运行中的工具卡收口', async () => {
    const toolMessage: ChatMessage = {
      id: 1, role: 'tool', text: '', time: '12:00', toolStatus: 'running',
      toolCallId: 'call-current', runId: 'run-current',
    }
    const unrelatedToolMessage: ChatMessage = {
      id: 2, role: 'tool', text: '', time: '12:00', toolStatus: 'running',
      toolCallId: 'call-old', runId: 'run-old',
    }
    const options = createOptions([toolMessage, unrelatedToolMessage])
    const stream = useChatStream(options)
    const cancel = vi.spyOn(agentApi, 'cancelSession').mockResolvedValue({} as never)
    let sseController!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) { sseController = controller },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))

    const consuming = stream.resumeStream(42)
    const controller = stream.abortCtrl.value
    expect(controller).not.toBeNull()
    stream.stopStreaming()
    stream.stopStreaming()

    expect(cancel).toHaveBeenCalledWith('42')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(controller?.signal.aborted).toBe(false)

    sseController.enqueue(new TextEncoder().encode(
      'data: {"type":"tool_call","run_id":"run-current","tool_call_id":"call-current","name":"shell","status":"running"}\n\n'
      + 'data: {"type":"done","run_id":"run-current","cancelled":true}\n\n',
    ))
    sseController.close()
    await consuming

    expect(toolMessage.toolStatus).toBe('cancelled')
    expect(unrelatedToolMessage.toolStatus).toBe('running')
  })

  it('新会话尚无 session_id 时等待绑定后再取消，保留取消终态并避免伪造空回复', async () => {
    const sessionId = ref<number | null>(null)
    const toolMessage: ChatMessage = {
      id: 1, role: 'tool', text: '', time: '12:00', toolStatus: 'running',
      toolCallId: 'call-current', runId: 'run-current',
    }
    const options = createOptions([toolMessage], sessionId)
    const stream = useChatStream(options)
    const cancel = vi.spyOn(agentApi, 'cancelSession').mockResolvedValue({} as never)
    vi.spyOn(trackApi, 'track').mockResolvedValue({} as never)
    let sseController!: ReadableStreamDefaultController<Uint8Array>
    let notifyFetchStarted!: () => void
    const fetchStarted = new Promise<void>(resolve => { notifyFetchStarted = resolve })
    const body = new ReadableStream<Uint8Array>({
      start(controller) { sseController = controller },
    })
    vi.stubGlobal('fetch', vi.fn(async () => {
      notifyFetchStarted()
      return new Response(body)
    }))

    options.inputText.value = '开始任务'
    const sending = stream.send()
    await fetchStarted
    const controller = stream.abortCtrl.value
    expect(controller).not.toBeNull()

    stream.stopStreaming()

    expect(controller?.signal.aborted).toBe(false)
    expect(cancel).not.toHaveBeenCalled()
    expect(options.setStatus).toHaveBeenCalledWith(expect.objectContaining({ kind: 'text' }))

    sseController.enqueue(new TextEncoder().encode(
      'data: {"type":"session_id","session_id":42}\n\n'
      + 'data: {"type":"tool_call","run_id":"run-current","tool_call_id":"call-current","name":"shell","status":"running"}\n\n'
      + 'data: {"type":"done","cancelled":true}\n\n',
    ))
    sseController.close()
    await sending

    expect(cancel).toHaveBeenCalledWith('42')
    expect(toolMessage.toolStatus).toBe('cancelled')
    expect(options.messages.value.some(message => message.text.includes('没有收到回复'))).toBe(false)
  })

  it('取消接口迟到失败时不覆盖已经到达的正常终态', async () => {
    const options = createOptions([])
    const stream = useChatStream(options)
    let rejectCancel!: (error: Error) => void
    const cancel = vi.spyOn(agentApi, 'cancelSession').mockReturnValue(new Promise((_, reject) => {
      rejectCancel = reject
    }) as never)
    let sseController!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) { sseController = controller },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))

    const consuming = stream.resumeStream(42)
    stream.stopStreaming()
    expect(cancel).toHaveBeenCalledOnce()

    sseController.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'))
    sseController.close()
    await consuming
    rejectCancel(new Error('late cancellation failure'))
    await Promise.resolve()

    expect(options.setStatus).not.toHaveBeenCalledWith({
      kind: 'text', label: i18n.global.t('chatUi.cancelFailed'),
    })
  })

  it('旧 SSE 的迟到 session_id 不会让停止按钮取消到新会话', async () => {
    const sessionId = ref<number | null>(42)
    const options = createOptions([], sessionId)
    const stream = useChatStream(options)
    const cancel = vi.spyOn(agentApi, 'cancelSession').mockResolvedValue({} as never)
    let notifyToolCallStarted!: () => void
    let releaseToolCall!: () => void
    let notifyOldSessionIdProcessed!: () => void
    const toolCallStarted = new Promise<void>(resolve => { notifyToolCallStarted = resolve })
    const oldSessionIdProcessed = new Promise<void>(resolve => { notifyOldSessionIdProcessed = resolve })
    options.scrollBottom = vi.fn(() => new Promise<void>(resolve => {
      releaseToolCall = resolve
      notifyToolCallStarted()
    }))
    options.fetchSessions = vi.fn(async () => { notifyOldSessionIdProcessed() })
    const streamControllers: ReadableStreamDefaultController<Uint8Array>[] = []
    const bodies = [0, 1].map(() => new ReadableStream<Uint8Array>({
      start(controller) { streamControllers.push(controller) },
    }))
    let fetchCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bodies[fetchCount++])))

    const oldRun = stream.resumeStream(42)
    const oldController = stream.abortCtrl.value
    streamControllers[0].enqueue(new TextEncoder().encode(
      'data: {"type":"tool_call","run_id":"old-run","tool_call_id":"old-call","name":"shell","status":"running"}\n\n'
      + 'data: {"type":"session_id","session_id":42}\n\n',
    ))
    await toolCallStarted
    sessionId.value = 84
    oldController?.abort()
    stream.abortCtrl.value = null
    stream.streaming.value = false
    const newRun = stream.resumeStream(84)
    const currentController = stream.abortCtrl.value
    releaseToolCall()
    await oldSessionIdProcessed
    stream.stopStreaming()

    expect(stream.abortCtrl.value).toBe(currentController)
    expect(cancel).toHaveBeenCalledWith('84')
    expect(cancel).toHaveBeenCalledTimes(1)

    streamControllers[0].close()
    streamControllers[1].enqueue(new TextEncoder().encode('data: {"type":"done","cancelled":true}\n\n'))
    streamControllers[1].close()
    await Promise.all([oldRun, newRun])
  })

  it('旧发送流收尾时不会清理同一视图中已经接管的新流状态', async () => {
    const options = createOptions([])
    const stream = useChatStream(options)
    vi.spyOn(trackApi, 'track').mockResolvedValue({} as never)
    let notifyFetchStarted!: () => void
    const fetchStarted = new Promise<void>(resolve => { notifyFetchStarted = resolve })
    let sseController!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) { sseController = controller },
    })
    vi.stubGlobal('fetch', vi.fn(async () => {
      notifyFetchStarted()
      return new Response(body)
    }))

    options.inputText.value = '旧流任务'
    const oldSend = stream.send()
    await fetchStarted
    const newController = new AbortController()
    stream.abortCtrl.value = newController
    stream.streaming.value = true

    sseController.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'))
    sseController.close()
    await oldSend

    expect(stream.abortCtrl.value).toBe(newController)
    expect(stream.streaming.value).toBe(true)
  })
})
