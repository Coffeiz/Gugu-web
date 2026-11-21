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
    vi.spyOn(agentApi, 'getMessages').mockRejectedValue(new Error('合成断网'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })


  it('流式正文更新在同一气泡中保持生成态，流结束后恢复静态展示', async () => {
    const options = createOptions([])
    const stream = useChatStream(options)
    const body = new TransformStream<Uint8Array>()
    const writer = body.writable.getWriter()
    const encoder = new TextEncoder()
    const write = (event: object) => writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body.readable)))

    const running = stream.resumeStream(42)
    const first = item('text-a', 'assistant', 1, { text: '第一段' })
    try {
      await write({ type: 'display_event', item: first })
      await vi.waitFor(() => expect(options.messages.value[0]).toMatchObject({ text: '第一段', streaming: true }))
      const id = options.messages.value[0].id

      await write({ type: 'display_event', item: { ...first, text: '第一段，新文字', updatedAt: '2026-01-01T01:03:00Z' } })
      await vi.waitFor(() => expect(options.messages.value).toMatchObject([{ id, text: '第一段，新文字', streaming: true }]))
      await write({ type: 'done' })
    } finally {
      await writer.close()
      await running
    }
    expect(options.messages.value[0]).toMatchObject({ text: '第一段，新文字', streaming: false })
  })

  it('桌面待发模型不可用时释放未消费的认领并保留消息', async () => {
    const options = createOptions([])
    const release = vi.fn(async () => true)
    const send = vi.fn(() => sseResponse([{ type: 'error', message: '模型不可用' }, { type: 'done' }]).body!)
    options.runAccess = {
      readState: async () => ({ status: 'idle' }),
      resume: () => { throw new Error('不应续看') },
      cancel: async () => ({ outcome: 'already_completed' }),
      readHistory: async () => ({ messages: [] }),
      createSession: async () => ({ id: 42 }),
      send,
    }
    options.queueAccess = {
      replace: vi.fn(async () => {}), patch: vi.fn(async () => {}),
      claim: vi.fn(async () => ({ claim_token: 'synthetic-claim' })), release,
    }
    const stream = useChatStream(options)
    stream.restorePendingQueueForSession(42, [{
      key: 1, queue_id: 'session-42', session_id: 42, text: '合成待发消息',
      attachments: [], references: [], modelId: 'unavailable-model', claimed: true,
    }])
    await stream.drainPendingQueue()
    expect(send).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledWith('session-42', 42, 1, 'synthetic-claim')
    expect(stream.pendingQueue.value).toMatchObject([{ key: 1, modelId: 'unavailable-model', claimed: false }])
  })

  it('桌面认领期间切换会话时，后台发送确认只清除原会话的待发消息', async () => {
    const sessionId = ref<number | null>(42)
    const options = createOptions([], sessionId)
    const release = vi.fn(async () => false)
    options.runAccess = {
      readState: async () => ({ status: 'idle' }),
      resume: () => { throw new Error('不应续看') },
      cancel: async () => ({ outcome: 'already_completed' }),
      readHistory: async () => ({ messages: [] }),
      createSession: async () => ({ id: 42 }),
      send: ({ id, clientMessageId }) => sseResponse([
        { type: 'session_id', session_id: id, client_message_id: clientMessageId },
        { type: 'done' },
      ]).body!,
    }
    options.queueAccess = {
      replace: vi.fn(async () => {}), patch: vi.fn(async () => {}), release,
      claim: vi.fn(async () => {
        sessionId.value = 84
        return { claim_token: 'synthetic-claim' }
      }),
    }
    const stream = useChatStream(options)
    stream.restorePendingQueueForSession(42, [{
      key: 1, queue_id: 'session-42', session_id: 42, text: '合成待发消息', attachments: [], references: [],
    }])
    await stream.drainPendingQueue()
    expect(stream.pendingQueue.value).toEqual([])
    expect(options.messages.value).toEqual([])
    expect(sessionId.value).toBe(84)
    expect(release).not.toHaveBeenCalled()
  })

  it('桌面恢复的待发消息使用入队时保存的模型', async () => {
    const options = createOptions([])
    const send = vi.fn(() => sseResponse([{ type: 'done' }]).body!)
    options.runAccess = {
      readState: async () => ({ status: 'idle' }),
      resume: () => { throw new Error('不应续看') },
      cancel: async () => ({ outcome: 'already_completed' }),
      readHistory: async () => ({ messages: [] }),
      createSession: async () => ({ id: 42 }),
      send,
    }
    options.queueAccess = {
      replace: vi.fn(async () => {}),
      patch: vi.fn(async () => {}),
      claim: vi.fn(async () => ({ claim_token: 'synthetic-claim' })),
      release: vi.fn(async () => {}),
    }
    const stream = useChatStream(options)
    stream.restorePendingQueueForSession(42, [{
      key: 1, queue_id: 'session-42', session_id: 42, text: '合成待发消息',
      attachments: [], references: [], modelId: 'queued-model',
    }])
    await stream.drainPendingQueue()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      id: 42, text: '合成待发消息', modelId: 'queued-model',
      queueClaim: { key: 1, token: 'synthetic-claim' },
    }), expect.any(AbortSignal))
  })

  it('桌面交互回复已完成时，按指定运行重放并呈现回答', async () => {
    const options = createOptions([])
    const readState = vi.fn(async () => ({ runId: 'run-a', status: 'completed' }))
    const resume = vi.fn(() => sseResponse([
      { type: 'display_event', item: item('replayed-reply', 'assistant', 1, { text: '合成交互已续跑' }) },
      { type: 'done' },
    ]).body!)
    options.runAccess = {
      readState, resume,
      cancel: async () => ({ outcome: 'already_completed' }),
      readHistory: async () => ({ messages: [] }),
      createSession: async () => ({ id: 42 }),
      send: () => { throw new Error('不应创建新运行') },
    }
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await useChatStream(options).resumeStream(42, 'run-a')
    expect(resume).toHaveBeenCalledWith(42, 'run-a', expect.any(AbortSignal))
    expect(readState).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(options.messages.value).toEqual([
      expect.objectContaining({ text: '合成交互已续跑', runId: 'run-a', streaming: false }),
    ])
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

  it('续接 IM Run 时，压缩开始事件把思考气泡切换为整理上下文', async () => {
    const options = createOptions([])
    const compacting = { kind: 'text' as const, label: '正在整理上下文…' }
    options.contextCompactingItem = () => compacting
    const stream = useChatStream(options)
    const body = new TransformStream<Uint8Array>()
    const writer = body.writable.getWriter()
    const send = (event: object) => writer.write(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body.readable)))

    const running = stream.resumeStream(42, 'run-im')
    try {
      await send({ type: '_context_compaction', phase: 'started', reason: 'usage_threshold' })
      await vi.waitFor(() => expect(options.setStatus).toHaveBeenLastCalledWith(compacting))
      await send({ type: '_context_compaction', phase: 'completed', applied: false })
      await vi.waitFor(() => expect(options.setStatus).toHaveBeenLastCalledWith(options.thinkingItem()))
    } finally {
      await writer.close()
      await running
    }
  })

  it('回复后进入新一轮时重新显示思考状态，直到本轮收到正文', async () => {
    const options = createOptions([])
    const updateSidebarRun = vi.fn()
    options.updateSidebarRun = updateSidebarRun
    const stream = useChatStream(options)
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      { type: 'display_event', item: item('text-first', 'assistant', 1, { text: '上一轮回复' }) },
      { type: 'round_start', run_id: 'run-a', round_id: 'r2' },
      { type: 'display_event', item: item('text-next', 'assistant', 2, { text: '新一轮回复', roundId: 'r2' }) },
      { type: 'done' },
    ])))
    await stream.resumeStream(42)
    expect(updateSidebarRun.mock.calls).toEqual([[42, 'run-a', true], [42, 'run-a', false]])
    const statusCalls = vi.mocked(options.setStatus).mock.invocationCallOrder
    const clearCalls = vi.mocked(options.clearStatus).mock.invocationCallOrder
    expect(statusCalls).toHaveLength(2)
    expect(statusCalls[1]).toBeGreaterThan(clearCalls[1]!)
    expect(statusCalls[1]).toBeLessThan(clearCalls[2]!)
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
    const history = vi.spyOn(agentApi, 'getMessages').mockResolvedValue({ timelineEvents: [saved] } as never)
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      { type: 'display_event', item: old },
      { type: 'display_event', item: item('temporary', 'assistant', 2, { text: '临时多余段' }) },
      { type: 'done' }, { type: 'done' },
    ])))
    await useChatStream(options).resumeStream(42)
    expect(history).toHaveBeenCalledExactlyOnceWith(42, { runId: 'run-a', limit: 200 })
    expect(options.messages.value.map(message => message.text)).toEqual(['其他 run', '最终内容', '下一条消息'])
  })

  it('续看重放时保留恢复的确认凭据，收尾时以已结束的历史卡片接替', async () => {
    const tool = item('tool-a', 'tool', 1, { toolCallId: 'c1', toolStatus: 'success' })
    const restored = {
      id: 17, title: '合成确认卡', kind: 'confirm', tool_call_id: 'c1',
      created_at: '2026-01-01T01:02:01Z', options: [{ id: 'confirm', token: 'renewed' }],
    }
    const options = createOptions(mapSessionMessageDelta({ interactions: [restored] }, () => 7, role => ({ role })))
    const history = vi.spyOn(agentApi, 'getMessages').mockImplementation(async () => {
      expect(options.messages.value.find(message => message.id === 7)?.interaction?.options[0]?.token).toBe('renewed')
      return { timelineEvents: [tool], interactions: [{ ...restored, options: [], resolved: true }] } as never
    })
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      { type: 'display_event', item: tool },
      { type: 'interaction_required', prompt_id: 17, ...restored, options: [{ id: 'confirm', token: 'expired' }] },
      { type: 'done' },
    ])))
    await useChatStream(options).resumeStream(42)
    expect(history).toHaveBeenCalledOnce()
    expect(options.messages.value.map(message => message.role)).toEqual(['tool', 'interaction'])
    expect(options.messages.value[1]).toMatchObject({ id: 7, interaction: { resolved: true, options: [] } })
  })

  it('等待确认结束观察流时保留本轮正文和工具卡，且继续用独立确认卡展示', async () => {
    const options = createOptions([])
    const history = vi.spyOn(agentApi, 'getMessages').mockResolvedValue({
      messages: [{ id: 42, role: 'user', content: '合成请求', runId: 'run-a' }],
    } as never)
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      { type: 'display_event', item: item('text-a', 'assistant', 1, { text: '确认前的正文' }) },
      { type: 'display_event', item: item('tool-a', 'tool', 2, { toolCallId: 'c1', toolStatus: 'waiting' }) },
      { type: 'interaction_required', prompt_id: 17, kind: 'confirm', title: '合成确认', tool_call_id: 'c1',
        options: [{ id: 'confirm', token: 'synthetic' }] },
      { type: 'done', run_id: 'run-a', waiting_for_interaction: true },
    ])))
    await useChatStream(options).resumeStream(42, 'run-a')
    expect(history).not.toHaveBeenCalled()
    expect(options.messages.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'ai', text: '确认前的正文', streaming: false }),
      expect.objectContaining({ role: 'tool', toolCallId: 'c1', toolStatus: 'waiting' }),
      expect.objectContaining({ role: 'interaction', interaction: expect.objectContaining({ promptId: 17 }) }),
    ]))
    expect(options.messages.value).toHaveLength(3)
  })

  it('续看收到已回答卡片时清除旧按钮并保持侧栏运行态', async () => {
    const restored = {
      id: 17, title: '合成提问', kind: 'question', run_id: 'run-a', allow_text_input: true,
      options: [{ id: 'confirm', token: 'obsolete' }],
    }
    const options = createOptions(mapSessionMessageDelta({ interactions: [restored] }, () => 7, role => ({ role })))
    const sidebar = vi.fn()
    options.updateSidebarRun = sidebar
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      { type: 'round_start', run_id: 'run-a', round_id: 'r1' },
      { type: 'interaction_required', ...restored, prompt_id: 17, resolved: true, options: [], response_text: '小北' },
      { type: 'round_start', run_id: 'run-a', round_id: 'r2' },
    ])))
    await useChatStream(options).resumeStream(42)
    expect(sidebar.mock.calls).toEqual([[42, 'run-a', true], [42, 'run-a', true]])
    expect(options.messages.value[0]).toMatchObject({
      id: 7, interaction: { resolved: true, options: [], responseText: '小北' },
    })
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

  it('工具事件状态和刷新后的卡片都使用管理员覆盖标签', async () => {
    const label = '正在核对已有项目'
    const tool = item('custom-tool', 'tool', 1, { toolName: 'list_projects', toolCallId: 'projects',
      toolStatus: 'running', toolLabelOverride: label })
    const finished = { ...tool, toolStatus: 'success' }
    vi.mocked(agentApi.getMessages).mockResolvedValue({ timelineEvents: [finished] } as never)
    const options = createOptions([])
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      { type: 'display_event', item: tool }, { type: 'done' },
    ])))
    await useChatStream(options).resumeStream(42)
    expect(options.setStatus).toHaveBeenCalledWith({ kind: 'text', label })
    expect(options.messages.value).toEqual([expect.objectContaining({ toolStatus: 'success', toolLabelOverride: label })])
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

  it('桌面终态历史跨页时读取到该运行的用户消息', async () => {
    const options = createOptions([])
    const readHistory = vi.fn(async (_id: number, before?: number) => before === undefined
      ? {
        messages: [],
        timelineEvents: [item('saved-answer', 'assistant', 2, { text: '已保存回答' })],
        pagination: { hasMore: true, oldestId: 8 },
      }
      : {
        messages: [{ id: 42, role: 'user', content: '跨页问题', runId: 'run-a', timelineOrder: 42 }],
        pagination: { hasMore: true, oldestId: 7 },
      })
    options.runAccess = {
      readHistory,
      readState: async () => ({ runId: 'run-a', status: 'running' }),
      resume: () => sseResponse([{ type: 'done', run_id: 'run-a' }]).body!,
      cancel: async () => ({ outcome: 'already_completed' }),
      createSession: async () => ({ id: 42 }),
      send: () => { throw new Error('不应发送新消息') },
    }
    await useChatStream(options).resumeStream(42, 'run-a')
    expect(readHistory.mock.calls).toEqual([[42, undefined], [42, 8]])
    expect(options.messages.value.map(message => message.text)).toEqual(['跨页问题', '已保存回答'])
  })

  it('仅重放取消终态时按终态运行 ID 收尾工具，并校准同一运行历史', async () => {
    const options = createOptions([
      { id: 5, role: 'tool', text: '', time: '12:00', runId: 'older-run', toolStatus: 'success' },
      { id: 6, role: 'tool', text: '', time: '12:00', runId: 'run-a', toolStatus: 'waiting' },
    ])
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      { type: 'done', run_id: 'run-a', cancelled: true },
    ])))
    await useChatStream(options).resumeStream(42, 'run-a')
    expect(options.messages.value.map(message => message.toolStatus)).toEqual(['success', 'cancelled'])
    expect(agentApi.getMessages).toHaveBeenCalledExactlyOnceWith(42, { runId: 'run-a', limit: 200 })
  })

  it.each(['run-a', 'another-run'])('发送确认后流断开，仅续看匹配的持久运行（%s）', async persistedRunId => {
    const options = createOptions([])
    const send = vi.fn(() => sseResponse([
      { type: 'session_id', session_id: 42, user_message_id: 42, run_id: 'run-a' },
      { type: 'error', message: '连接中断', delivery_interrupted: true },
    ]).body!)
    const resume = vi.fn(() => {
      const time = new Date(Date.now() + 1000).toISOString()
      return sseResponse([
        { type: 'display_event', item: item('recovered-answer', 'assistant', 1, { text: '已续看答复', createdAt: time, updatedAt: time }) },
        { type: 'done', run_id: 'run-a' },
      ]).body!
    })
    const readState = vi.fn(async () => ({ runId: persistedRunId, status: 'running' }))
    options.syncResumedHistory = vi.fn(async () => {})
    options.runAccess = {
      send, resume, readState,
      cancel: async () => ({ outcome: 'already_completed' }),
      readHistory: async () => ({ messages: [] }),
      createSession: async () => ({ id: 42 }),
    }
    options.inputText.value = '合成问题'
    await useChatStream(options).send()
    expect(send).toHaveBeenCalledOnce()
    expect(readState).toHaveBeenCalledExactlyOnceWith(42)
    if (persistedRunId === 'run-a') {
      expect(resume).toHaveBeenCalledExactlyOnceWith(42, 'run-a', expect.any(AbortSignal))
      expect(options.messages.value.map(message => message.text)).toEqual(['合成问题', '已续看答复'])
    } else {
      expect(resume).not.toHaveBeenCalled()
      expect(options.syncResumedHistory).toHaveBeenCalledExactlyOnceWith(42)
    }
  })

  it('桌面已存在会话的停止操作等待发送确认，并只取消本流绑定的运行', async () => {
    const options = createOptions([])
    const cancel = vi.fn(async () => ({ outcome: 'requested' }))
    const started = Promise.withResolvers<void>()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    options.runAccess = {
      cancel,
      readState: async () => ({ runId: 'another-run', status: 'running' }),
      readHistory: async () => ({ messages: [] }),
      createSession: async () => ({ id: 42 }),
      resume: () => { throw new Error('不应续看') },
      send() { started.resolve(); return body },
    }
    const stream = useChatStream(options)
    options.inputText.value = '合成问题'
    const sending = stream.send()
    await started.promise
    try {
      stream.stopStreaming()
      expect(cancel).not.toHaveBeenCalled()
      controller.enqueue(new TextEncoder().encode(
        'data: {"type":"session_id","session_id":42,"run_id":"submitted-run"}\n\n'
        + 'data: {"type":"done","run_id":"submitted-run","cancelled":true}\n\n',
      ))
    } finally {
      controller.close()
      await sending
    }
    expect(cancel).toHaveBeenCalledExactlyOnceWith(42, 'submitted-run')
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

  it('切到空白新对话后，旧连接结束也不插入空回复提示', async () => {
    const options = createOptions([])
    let viewGeneration = 0
    options.getViewGeneration = () => viewGeneration
    const stream = useChatStream(options)
    const fetchStarted = Promise.withResolvers<void>()
    const response = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', vi.fn(() => {
      fetchStarted.resolve()
      return response.promise
    }))
    options.inputText.value = '合成消息'
    const sending = stream.send()
    await fetchStarted.promise

    viewGeneration++
    options.sessionId.value = null
    options.messages.value = []
    response.resolve(sseResponse([{ type: 'done' }]))
    await sending

    expect(options.messages.value).toEqual([])
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
