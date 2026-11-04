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


function item(eventId: string, kind: string, sequence: number, extra: Record<string, unknown> = {}) {
  return { eventId, kind, sequence, anchorMessageId: 42, timelineOrder: 42000000 + sequence,
    runId: 'run-a', roundId: 'r1', text: '', createdAt: '2026-01-01T01:02:00Z', updatedAt: '2026-01-01T01:02:00Z', ...extra }
}

function sseResponse(events: object[]) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')))
      controller.close()
    },
  }))
}

describe('useChatStream 展示事件与生命周期', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.spyOn(agentApi, 'getRunMessages').mockRejectedValue(new Error('合成断网'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })


  it('同一事件快照重复到达仍保持时间、位置，正文按版本替换而非累加', async () => {
    const first = item('text-a', 'assistant', 1, { text: '已生成', roundId: 'r1' })
    const tool = item('tool-a', 'tool', 2, { toolCallId: 'c1', toolName: 'shell', toolStatus: 'success' })
    const options = createOptions(mapSessionMessageDelta({ timelineEvents: [first, tool] }, (() => { let id = 1; return () => id++ })(), role => ({ role })))
    const before = options.messages.value.map(message => [message.id, message.time, message._timelineOrder])
    const stream = useChatStream(options)
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      { type: 'display_event', item: first }, { type: 'display_event', item: first },
      { type: 'display_event', item: { ...first, text: '已生成完整正文', updatedAt: '2026-01-01T01:03:00Z' } },
      { type: 'done' },
    ])))
    await stream.resumeStream(42)
    expect(options.messages.value.map(message => [message.id, message.time, message._timelineOrder])).toEqual(before)
    expect(options.messages.value[0].text).toBe('已生成完整正文')
    expect(options.messages.value).toHaveLength(2)
  })

  it('收到流终态时刷新会话运行态，修复丢失独立完成通知后的侧栏动画残留', async () => {
    const options = createOptions([])
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([{ type: 'done' }])))

    await useChatStream(options).resumeStream(42)

    expect(options.fetchSessions).toHaveBeenCalledOnce()
  })

  it('完成通知按 run 接替历史，删除临时段并保留其他 run 和下一条用户消息', async () => {
    const old = item('text-a', 'assistant', 1, { text: '临时内容' })
    const saved = item('text-a', 'assistant', 1, { text: '最终内容' })
    const options = createOptions([
      { id: 1, role: 'user', text: '下一条消息', time: '10:00', _timelineOrder: 99000000 },
      { id: 2, role: 'ai', text: '其他 run', runId: 'run-other', time: '09:00', _timelineOrder: 1 },
    ])
    const history = vi.spyOn(agentApi, 'getRunMessages').mockResolvedValue({ timelineEvents: [saved] } as never)
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      { type: 'display_event', item: old },
      { type: 'display_event', item: item('temporary', 'assistant', 2, { text: '临时多余段' }) },
      { type: 'done' }, { type: 'done' },
    ])))
    await useChatStream(options).resumeStream(42)
    expect(history).toHaveBeenCalledWith(42, 'run-a')
    expect(options.messages.value.map(message => message.text)).toEqual(['其他 run', '最终内容', '下一条消息'])
  })

  it('并行工具各自更新同一事件，不重置首次时间和顺序', async () => {
    const events = [
      item('tool-a', 'tool', 1, { toolName: 'shell', toolCallId: 'a', toolStatus: 'running' }),
      item('tool-b', 'tool', 2, { toolName: 'shell', toolCallId: 'b', toolStatus: 'running' }),
      item('tool-b', 'tool', 2, { toolName: 'shell', toolCallId: 'b', toolStatus: 'success', toolDurationMs: 12 }),
      item('tool-a', 'tool', 1, { toolName: 'shell', toolCallId: 'a', toolStatus: 'error', toolDurationMs: 20 }),
    ]
    const options = createOptions([])
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([...events.map(item => ({ type: 'display_event', item })), { type: 'done' }])))
    await useChatStream(options).resumeStream(42)
    expect(options.messages.value.map(message => [message.toolCallId, message.toolStatus, message.toolDurationMs])).toEqual([['a', 'error', 20], ['b', 'success', 12]])
  })

  it('同一附件事件重复重放不产生第二张文件卡', async () => {
    const file = item('file-a', 'assistant', 1, { files: [{ file_id: 19 }] })
    const options = createOptions([])
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      { type: 'display_event', item: file }, { type: 'display_event', item: file }, { type: 'done' },
    ])))
    await useChatStream(options).resumeStream(42)
    expect(options.messages.value).toHaveLength(1)
    expect(options.messages.value[0].files).toEqual([{ file_id: 19 }])
  })

  it('网页 present_file 副作用仍仅交给发起标签页', async () => {
    const options = createOptions([])
    options.onPresentFile = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      { type: 'tool_done', name: 'present_file', status: 'success', origin_client_id: CLIENT_ID, result: { ok: true, file_id: 17, name: '设计稿', ext: 'png' } },
      { type: 'tool_done', name: 'present_file', status: 'success', origin_client_id: 'another-tab', result: { ok: true, file_id: 18, name: '其他文件', ext: 'png' } },
      { type: 'done' },
    ])))
    await useChatStream(options).resumeStream(42)
    expect(options.onPresentFile).toHaveBeenCalledOnce()
    expect(options.onPresentFile).toHaveBeenCalledWith({ file_id: 17, name: '设计稿', ext: 'png' })
  })

  it('自动模式命令完成后刷新偏好，避免聊天开关与服务端设置脱节', async () => {
    const options = createOptions([])
    options.inputText.value = '/auto on'
    options.onAutomaticModeCommand = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([{ type: 'done' }])))

    await useChatStream(options).send()

    expect(options.onAutomaticModeCommand).toHaveBeenCalledOnce()
  })

  it('发送时为乐观气泡和服务端请求分配同一客户端消息身份', async () => {
    const options = createOptions([])
    options.inputText.value = '架构身份测试'
    let requestBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))
      return sseResponse([
        { type: 'session_id', session_id: 42, user_message_id: 73 },
        { type: 'done' },
      ])
    }))

    await useChatStream(options).send()

    expect(typeof requestBody?.client_message_id).toBe('string')
    const userMessages = options.messages.value.filter(message => message.role === 'user')
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0]).toMatchObject({
      role: 'user', dbId: 73,
      clientMessageId: requestBody?.client_message_id,
      _syncKey: `client:${requestBody?.client_message_id}`,
    })
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
      'data: {"type":"round_start","run_id":"run-current","tool_call_id":"call-current","name":"shell","status":"running"}\n\n'
      + 'data: {"type":"done","run_id":"run-current","cancelled":true}\n\n',
    ))
    sseController.close()
    await consuming

    expect(toolMessage.toolStatus).toBe('cancelled')
    expect(unrelatedToolMessage.toolStatus).toBe('running')
    expect(options.setStatus).toHaveBeenCalledWith({
      kind: 'text', label: i18n.global.t('chatUi.runInterrupted'),
    })
  })

  it('取消请求到达时 run 已结束，提示来不及中断', async () => {
    const sessionId = ref<number | null>(42)
    const options = createOptions([], sessionId)
    const stream = useChatStream(options)
    vi.spyOn(agentApi, 'cancelSession').mockResolvedValue({
      ok: true, active: false, recovered: false, cancelled_locally: false,
      outcome: 'already_completed',
    })
    let sseController!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) { sseController = controller },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))

    const consuming = stream.resumeStream(42)
    stream.stopStreaming()
    await Promise.resolve()
    expect(options.setStatus).toHaveBeenCalledWith({
      kind: 'text', label: i18n.global.t('chatUi.cancelTooLate'),
    })
    sseController.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'))
    sseController.close()
    await consuming
  })

  it('远端取消未确认时提示本地停止且远端状态未知', async () => {
    const options = createOptions([])
    const stream = useChatStream(options)
    let sseController!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) { sseController = controller },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))

    const consuming = stream.resumeStream(42)
    sseController.enqueue(new TextEncoder().encode(
      'data: {"type":"done","cancelled":true,"remote_status_unknown":true}\n\n',
    ))
    sseController.close()
    await consuming
    expect(options.setStatus).toHaveBeenCalledWith({
      kind: 'text', label: i18n.global.t('chatUi.cancelRemoteUnknown'),
    })
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
      + 'data: {"type":"round_start","run_id":"run-current","tool_call_id":"call-current","name":"shell","status":"running"}\n\n'
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
    options.syncResumedHistory = vi.fn(() => new Promise<void>(resolve => {
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
      'data: {"type":"display_event","item":{"eventId":"old-event","kind":"tool","runId":"old-run","roundId":"r1","timelineOrder":1,"createdAt":"2026-01-01T01:00:00Z"},"run_id":"old-run","tool_call_id":"old-call","name":"shell","status":"running"}\n\n'
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
