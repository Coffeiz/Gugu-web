import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n'
import { agentApi, CLIENT_ID, trackApi } from '@/services/api'
import { useChatStream } from '@/components/common/gugu-chat/composables/useChatStream'
import { mapSessionMessageDelta, mergeSessionMessageDelta } from '@/components/common/gugu-chat/composables/sessionMessageSync'
import type { ChatMessage } from '@/components/common/gugu-chat/chatTypes'

vi.mock('@/services/sfx', () => ({ playGuguSfx: vi.fn() }))

function createOptions(messages: ChatMessage[], sessionId = ref<number | null>(42)) {
  let nextId = 100
  return {
    messages: ref(messages),
    mkid: () => nextId++,
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

  it('SSE owner run 与核心 run 不同时，持久化副本仍合并到实时回复气泡', async () => {
    const options = createOptions([])
    const stream = useChatStream(options)
    const events = [
      { type: 'round_start', run_id: 'owner-run', core_run_id: 'core-run', round_id: 'round-2' },
      { type: 'token', run_id: 'owner-run', core_run_id: 'core-run', round_id: 'round-2', content: '实时回答正文' },
      { type: 'done', run_id: 'owner-run', core_run_id: 'core-run' },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')))
        controller.close()
      },
    }))))
    await stream.resumeStream(42)
    const persisted = mapSessionMessageDelta({ messages: [{ id: 91, role: 'assistant',
      content: '已持久化回答正文', runId: 'core-run', roundId: 'round-2', createdAt: '' }],
    timelineEvents: [], toolEvents: [] }, () => 200, role => ({ role: role === 'assistant' ? 'ai' : role }))
    const merged = mergeSessionMessageDelta(options.messages.value, persisted)
    expect(merged.filter(item => item.role === 'ai')).toHaveLength(1)
    expect(merged.find(item => item.role === 'ai')).toMatchObject({
      id: options.messages.value.find(item => item.role === 'ai')?.id,
      dbId: 91, runId: 'core-run', roundId: 'round-2', text: '已持久化回答正文',
    })
  })

  it('同一工具调用从排队中更新为进行中且只保留一张卡片', async () => {
    const options = createOptions([])
    const stream = useChatStream(options)
    let sseController!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) { sseController = controller },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))

    const consuming = stream.resumeStream(42)
    const send = (value: object) => sseController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`))
    send({ type: 'tool_call', run_id: 'run-1', round_id: 'round-1', tool_call_id: 'call-1', name: 'shell', status: 'queued' })
    await vi.waitFor(() => expect(options.messages.value[0]?.toolStatus).toBe('queued'))
    send({ type: 'tool_call', run_id: 'run-1', round_id: 'round-1', tool_call_id: 'call-1', name: 'shell', status: 'running' })
    await vi.waitFor(() => expect(options.messages.value[0]?.toolStatus).toBe('running'))
    send({ type: 'tool_done', run_id: 'run-1', round_id: 'round-1', tool_call_id: 'call-1', name: 'shell', status: 'success' })
    send({ type: 'done', run_id: 'run-1' })
    sseController.close()
    await consuming

    expect(options.messages.value).toHaveLength(1)
    expect(options.messages.value[0]?.toolStatus).toBe('success')
  })

  it('当前网页对话成功调用 present_file 时将文件交给该网页预览', async () => {
    const options = createOptions([])
    const onPresentFile = vi.fn()
    options.onPresentFile = onPresentFile
    const stream = useChatStream(options)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          { type: 'tool_done', name: 'present_file', status: 'success', origin_client_id: CLIENT_ID, result: { ok: true, file_id: 17, name: '设计稿', ext: 'png' } },
          { type: 'tool_done', name: 'present_file', status: 'success', origin_client_id: 'another-tab', result: { ok: true, file_id: 18, name: '其他标签页文件', ext: 'png' } },
          { type: 'done', run_id: 'run-1' },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')))
        controller.close()
      },
    }))))

    await stream.resumeStream(42)

    expect(onPresentFile).toHaveBeenCalledWith({ file_id: 17, name: '设计稿', ext: 'png' })
    expect(onPresentFile).toHaveBeenCalledTimes(1)
  })

  it('不同回合复用相同 toolCallId 时仍分别更新各自的工具卡', async () => {
    const options = createOptions([])
    const stream = useChatStream(options)
    let sseController!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(controller) { sseController = controller } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))

    const consuming = stream.resumeStream(42)
    const send = (value: object) => sseController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`))
    send({ type: 'round_start', core_run_id: 'run-a', round_id: 'r1' })
    send({ type: 'tool_call', core_run_id: 'run-a', round_id: 'r1', tool_call_id: 'call-1', name: 'search', status: 'running' })
    send({ type: 'tool_done', core_run_id: 'run-a', round_id: 'r1', tool_call_id: 'call-1', name: 'search', status: 'success' })
    send({ type: 'round_start', core_run_id: 'run-a', round_id: 'r2' })
    send({ type: 'tool_call', core_run_id: 'run-a', round_id: 'r2', tool_call_id: 'call-1', name: 'search', status: 'running' })
    send({ type: 'tool_done', core_run_id: 'run-a', round_id: 'r2', tool_call_id: 'call-1', name: 'search', status: 'error' })
    send({ type: 'done', core_run_id: 'run-a' })
    sseController.close()
    await consuming

    const tools = options.messages.value.filter(message => message.role === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools.map(({ runId, roundId, toolStatus, _syncKey }) => ({ runId, roundId, toolStatus, _syncKey }))).toEqual([
      { runId: 'run-a', roundId: 'r1', toolStatus: 'success', _syncKey: 'tool-call:["run-a","r1","call-1"]' },
      { runId: 'run-a', roundId: 'r2', toolStatus: 'error', _syncKey: 'tool-call:["run-a","r2","call-1"]' },
    ])
  })

  it('失败终态更新原用户消息且不伪造 assistant 错误消息', async () => {
    const userMessage: ChatMessage = { id: 7, dbId: 42, role: 'user', text: '测试请求', time: '12:00' }
    const options = createOptions([userMessage])
    const stream = useChatStream(options)
    let sseController!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) { sseController = controller },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))

    const consuming = stream.resumeStream(42)
    sseController.enqueue(new TextEncoder().encode(
      'data: {"type":"error","user_message_id":42,"run_outcome":{"status":"failed","errorCode":"provider_unavailable","messageKey":"chatUi.providerUnavailable","messageParams":{"tag":"500"}}}\n\n',
    ))
    sseController.close()
    await consuming

    expect(userMessage.runOutcome).toMatchObject({
      status: 'failed', errorCode: 'provider_unavailable',
      messageKey: 'chatUi.providerUnavailable',
    })
    expect(options.messages.value.filter(message => message.role === 'ai')).toHaveLength(0)
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
      'data: {"type":"session_id","session_id":42,"user_message_id":73}\n\n'
      + 'data: {"type":"tool_call","run_id":"run-current","tool_call_id":"call-current","name":"shell","status":"running"}\n\n'
      + 'data: {"type":"done","cancelled":true,"user_message_id":73,"run_outcome":{"status":"interrupted","errorCode":"cancelled"}}\n\n',
    ))
    sseController.close()
    await sending

    expect(cancel).toHaveBeenCalledWith('42')
    expect(toolMessage.toolStatus).toBe('cancelled')
    expect(options.messages.value.find(message => message.dbId === 73)?.runOutcome?.status).toBe('interrupted')
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
