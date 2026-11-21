import { ref } from 'vue'
import { getLocale, setLocale } from '@/i18n'
import { desktopSkillsApi } from '../../src/desktop/resources/transport'
import { useConfirmDialog } from '@/composables/core/useConfirmDialog'
import { expect, it, vi } from 'vitest'
import type { DesktopAgentChatEvent, DesktopAgentHistoryPage, DesktopAgentSessionCommand } from '@gugu/core/desktop'
import { createDesktopChatEventStream, desktopHistoryToWebShape, getDesktopChatHistory, getDesktopChatHistoryThroughMessage } from '../../src/desktop/shell/agent-chat'
import { createDesktopChatCommandAccess, listDesktopChatCommands } from '../../src/desktop/shell/chat-command-access'
import { subscribeDesktopAgentRunChanges } from '../../src/desktop/shell/agent-session-transport'
import { requestDesktopAgentModel, requestDesktopAuxiliaryModel } from '../../src/desktop/account/agent-model-transport'
import { downloadDesktopAgentAttachment, uploadDesktopAgentAttachment } from '../../src/desktop/shell/agent-attachment-transport'

it('Desktop 历史映射保留附件、引用、聊天时间线、交互和运行态', () => {
  const history = {
    messages: [{
      id: 12, role: 'user', text: '合成问题', createdAt: '2026-01-01T00:00:00Z', runId: 'synthetic-run',
      files: [{ attach_id: 'synthetic-attachment', name: '录音', ext: 'webm', kind: 'voice', size: 123, duration: 2 }],
      references: [{ type: 'project', id: 3, label: '合成项目' }],
      toolTimeline: [{ kind: 'tool', eventId: 'tool-event', runId: 'synthetic-run', roundId: 'r1', sequence: 1,
        anchorMessageId: '12', timelineOrder: '12.1', createdAt: '2026-01-01T00:00:01Z', updatedAt: '2026-01-01T00:00:02Z',
        toolCallId: 'call-1', toolName: 'web_search', toolStatus: 'success' }],
      assistantTimeline: [{ kind: 'assistant', eventId: 'assistant-event', runId: 'synthetic-run', roundId: 'r1', sequence: 2,
        anchorMessageId: '12', timelineOrder: '12.2', createdAt: '2026-01-01T00:00:02Z', updatedAt: '2026-01-01T00:00:03Z', text: '合成回复' }],
      interactions: [{ id: 8, run_id: 'synthetic-run', kind: 'choice', title: '合成确认', resolved: false }],
    }],
    pagination: { hasMore: true, oldestId: 12 },
  } as unknown as DesktopAgentHistoryPage

  expect(desktopHistoryToWebShape(history, true)).toMatchObject({
    messages: [{ id: 12, role: 'user', content: '合成问题', runId: 'synthetic-run',
      files: [{ attach_id: 'synthetic-attachment', kind: 'voice', size_bytes: 123, duration: 2 }],
      references: [{ type: 'project', id: 3, label: '合成项目' }],
    }],
    timelineEvents: [{ eventId: 'tool-event' }, { eventId: 'assistant-event' }],
    interactions: [{ id: 8, run_id: 'synthetic-run' }],
    pagination: { hasMore: true, oldestId: 12 },
    active: true,
  })
})

it('Desktop 历史用已持久化的助手时间线显示回答，避免重复气泡', () => {
  const history = {
    messages: [
      { id: 1, role: 'assistant', text: '普通问候' },
      { id: 2, role: 'assistant', text: '已持久化回答', assistantTimeline: [
        { kind: 'assistant', eventId: 'reply', text: '已持久化回答' },
      ] },
      { id: 3, role: 'assistant', text: '纯链接以外的正文', assistantTimeline: [
        { kind: 'assistant', eventId: 'buttons', text: '', linkButtons: { kind: 'link_buttons' } },
      ] },
      { id: 4, role: 'assistant', text: '', toolTimeline: [
        { kind: 'tool', eventId: 'recovered-tool', toolStatus: 'success', detailsAvailable: true },
      ] },
    ],
    pagination: { hasMore: false, oldestId: 1 },
  } as unknown as DesktopAgentHistoryPage
  const projected = desktopHistoryToWebShape(history)
  expect(projected.messages.map(message => message.content)).toEqual(['普通问候', '纯链接以外的正文'])
  expect(projected.timelineEvents.map(event => event.eventId)).toEqual(['reply', 'buttons', 'recovered-tool'])
})

it('Desktop 搜索跳转通过本地历史分页读取目标消息', async () => {
  const target = window as Window & { guguDesktop?: Record<string, unknown> }
  const previous = target.guguDesktop
  const requests: unknown[] = []
  target.guguDesktop = {
    async agentSessions(command: DesktopAgentSessionCommand) {
      requests.push(command)
      if (command.action !== 'history') throw new Error('预期读取本地历史')
      const page = command.before === undefined
        ? { messages: [{ id: 90, role: 'assistant', text: '最近消息', createdAt: '2026-01-02T00:00:00Z' }],
          pagination: { hasMore: true, oldestId: 90 } }
        : { messages: [{ id: 42, role: 'user', text: '搜索命中', createdAt: '2026-01-01T00:00:00Z' }],
          pagination: { hasMore: false, oldestId: 42 } }
      return { ok: true, result: page }
    },
  }
  try {
    const history = await getDesktopChatHistoryThroughMessage(7, 42)
    expect(requests).toEqual([{ action: 'history', id: 7 }, { action: 'history', id: 7, before: 90 }])
    expect(history.messages).toMatchObject([{ id: 42, content: '搜索命中' }, { id: 90, content: '最近消息' }])
    expect(history.pagination).toEqual({ hasMore: false, oldestId: 42 })
  } finally {
    if (previous) target.guguDesktop = previous
    else delete target.guguDesktop
  }
})

it('桌面向前翻页只读取目标历史页', async () => {
  const agentSessions = vi.fn(async () => ({
    ok: true, result: { messages: [], pagination: { hasMore: false, oldestId: null } },
  }))
  vi.stubGlobal('guguDesktop', { agentSessions })
  try {
    await expect(getDesktopChatHistory(7, 42)).resolves.toMatchObject({ messages: [], pendingQueue: [] })
    expect(agentSessions).toHaveBeenCalledExactlyOnceWith({ action: 'history', id: 7, before: 42 })
  } finally { vi.unstubAllGlobals() }
})

it('Desktop 附件下载通过本机桥返回字节，不请求 Web 附件地址', async () => {
  const target = window as Window & { guguDesktop?: Record<string, unknown> }
  const previous = target.guguDesktop
  target.guguDesktop = {
    async agentAttachment(command: { action: string; attachId: string }) {
      expect(command).toEqual({ action: 'download', attachId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' })
      return { ok: true, result: { name: '合成语音.wav', mime: 'audio/wav', data: new TextEncoder().encode('synthetic-audio') } }
    },
  }
  try {
    const result = await downloadDesktopAgentAttachment('a1b2c3d4e5f60718293a4b5c6d7e8f90')
    expect(result.name).toBe('合成语音.wav')
    expect(result.blob.type).toBe('audio/wav')
    expect(await result.blob.text()).toBe('synthetic-audio')
  } finally {
    if (previous) target.guguDesktop = previous
    else delete target.guguDesktop
  }
})

it('Desktop SSE 事件通过 Web 聊天流协议转发并输出终态', async () => {
  const target = window as Window & { guguDesktop?: Record<string, unknown> }
  const previous = target.guguDesktop
  const previousLocale = getLocale()
  const listeners = new Set<(event: DesktopAgentChatEvent) => void>()
  const operationId = '00000000-0000-4000-8000-000000000001'
  const reference = { type: 'file', id: 'drop-synthetic', label: '合成图片.png' }
  const references = ref([reference]).value.slice()
  target.guguDesktop = {
    onAgentChatEvent(listener: (event: DesktopAgentChatEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async agentSessions(command: DesktopAgentSessionCommand) {
      if (command.action !== 'send') throw new Error('预期发送命令')
      expect(structuredClone(command).references).toEqual([reference])
      expect(command.locale).toBe('ja-JP')
      for (const listener of listeners) listener({ type: 'session_id', operationId, session_id: 12,
        user_message_id: 11, run_id: 'synthetic-run', client_message_id: 'synthetic-client' })
      for (const listener of listeners) listener({ type: 'projected', operationId,
        event: { type: 'round_start', run_id: 'synthetic-run', round_id: 'r1' } })
      for (const listener of listeners) listener({ type: 'projected', operationId,
        event: { type: 'display_event', item: { kind: 'assistant', eventId: 'assistant-event', runId: 'synthetic-run', roundId: 'r1', sequence: 1,
          anchorMessageId: '12', timelineOrder: '12.1', createdAt: '2026-01-01T00:00:01Z',
          updatedAt: '2026-01-01T00:00:01Z', text: '合成回复' } } })
      for (const listener of listeners) listener({ type: 'projected', operationId,
        event: { type: 'tool_done', tool_call_id: 'call-1', name: 'web_search', status: 'success' } })
      for (const listener of listeners) listener({ type: 'projected', operationId,
        event: { type: 'interaction_required', prompt_id: 4, core_run_id: 'synthetic-run', options: [] } })
      return { ok: true, result: [{ id: 12, role: 'assistant', text: '合成回复', createdAt: '2026-01-01T00:00:01Z', runId: 'synthetic-run' }] }
    },
  }
  try {
    setLocale('ja-JP')
    const stream = createDesktopChatEventStream({ action: 'send', id: 12, text: '合成问题', operationId, references }, new AbortController().signal)
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let wire = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      wire += decoder.decode(value, { stream: true })
    }
    const events = wire.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.slice(6)))
    expect(events.map(event => event.type)).toEqual([
      'session_id', 'round_start', 'display_event', 'tool_done', 'interaction_required', 'done',
    ])
    expect(events[0]).toMatchObject({ session_id: 12, user_message_id: 11, run_id: 'synthetic-run' })
    expect(events.at(-1)).toMatchObject({ run_id: 'synthetic-run', waiting_for_interaction: true })
  } finally {
    setLocale(previousLocale)
    if (previous) target.guguDesktop = previous
    else delete target.guguDesktop
  }
})

it.each([true, false])('桌面流缺少确认时只用匹配的持久消息确认发送（匹配=%s）', async matches => {
  const operationId = crypto.randomUUID()
  const clientMessageId = 'current-client'
  const runId = 'current-run'
  let receive: ((event: DesktopAgentChatEvent) => void) | undefined
  vi.stubGlobal('guguDesktop', {
    onAgentChatEvent(listener: (event: DesktopAgentChatEvent) => void) {
      receive = listener
      return () => {}
    },
    async agentSessions() {
      receive?.({ type: 'projected', operationId, event: { type: 'done', run_id: runId } })
      return { ok: true, result: [{
        id: 11, role: 'user', text: '合成问题', createdAt: '2026-01-01T00:00:00Z',
        clientMessageId: matches ? clientMessageId : 'older-client',
        runId: matches ? runId : 'older-run',
      }] }
    },
  })
  try {
    setLocale('ja-JP')
    const stream = createDesktopChatEventStream({
      action: 'send', id: 12, text: '合成问题', clientMessageId, operationId,
    }, new AbortController().signal)
    const wire = await new Response(stream).text()
    const events = wire.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.slice(6)))
    expect(events).toEqual([
      ...(matches ? [{ type: 'session_id', session_id: 12, user_message_id: 11, client_message_id: clientMessageId, run_id: runId }] : []),
      { type: 'done', run_id: runId },
    ])
  } finally {
    vi.unstubAllGlobals()
  }
})

it('Desktop 运行失败时沿用 Web SSE 的 error 和 done 事件收口', async () => {
  const target = window as Window & { guguDesktop?: Record<string, unknown> }
  const previous = target.guguDesktop
  target.guguDesktop = {
    onAgentChatEvent() { return () => {} },
    async agentSessions() { throw new Error('合成模型错误') },
  }
  try {
    const stream = createDesktopChatEventStream({ action: 'send', id: 12, text: '合成问题', operationId:
      '00000000-0000-4000-8000-000000000004' }, new AbortController().signal)
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let wire = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      wire += decoder.decode(value, { stream: true })
    }
    const events = wire.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.slice(6)))
    expect(events).toEqual([
      { type: 'error', message: '生成失败，请稍后重试' },
      { type: 'done' },
    ])
  } finally {
    if (previous) target.guguDesktop = previous
    else delete target.guguDesktop
  }
})

it('取消桌面聊天流的 reader 时只断开该次监听', async () => {
  const target = window as Window & { guguDesktop?: Record<string, unknown> }
  const previous = target.guguDesktop
  const operations: DesktopAgentSessionCommand[] = []
  const unsubscribe = vi.fn()
  const operationId = '00000000-0000-4000-8000-000000000005'
  let settle: () => void = () => {}
  target.guguDesktop = {
    onAgentChatEvent() { return unsubscribe },
    async agentSessions(command: DesktopAgentSessionCommand) {
      operations.push(command)
      if (command.action === 'resume') await new Promise<void>(resolve => { settle = resolve })
      else settle()
      return { ok: true, result: [] }
    },
  }
  try {
    const stream = createDesktopChatEventStream({
      action: 'resume', id: 12, runId: 'synthetic-run', operationId,
    }, new AbortController().signal)
    await stream.getReader().cancel()
    expect(operations.map(command => command.action)).toEqual(['resume', 'disconnect'])
    expect(operations[1]).toMatchObject({ operationId })
    expect(unsubscribe).toHaveBeenCalled()
  } finally {
    settle()
    if (previous) target.guguDesktop = previous
    else delete target.guguDesktop
  }
})

it('预览通知流断线后重连并补读状态，退订后停止重试', async () => {
  vi.useFakeTimers()
  const previous = location.href
  history.replaceState(null, '', '?desktopPreview=1')
  const signals: AbortSignal[] = []
  const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    signals.push(init!.signal!)
    expect(init?.headers).toMatchObject({ Accept: 'text/event-stream' })
    expect(JSON.parse(String(init?.body))).toMatchObject({ args: [{ action: 'watchRuns' }] })
    if (signals.length === 1) return new Response(null, { status: 503 })
    return new Response('data: {"type":"ready"}\n\ndata: {"type":"run_changed","session_id":42}\n\n',
      { headers: { 'content-type': 'text/event-stream' } })
  })
  vi.stubGlobal('fetch', request)
  const changed = vi.fn()
  const unsubscribe = subscribeDesktopAgentRunChanges(changed)
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(1)
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(changed.mock.calls).toEqual([[], [42]])
    expect(request).toHaveBeenCalledTimes(2)
    unsubscribe()
    expect(signals.every(signal => signal.aborted)).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(request).toHaveBeenCalledTimes(2)
  } finally {
    unsubscribe()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    history.replaceState(null, '', previous)
  }
})

it('原生桌面缺少附件桥接时返回更新提示且不请求 Web', async () => {
  const target = window as Window & { guguDesktop?: Record<string, unknown> }
  const previous = target.guguDesktop
  target.guguDesktop = {}
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  try {
    const file = new File(['合成内容'], 'synthetic.txt', { type: 'text/plain' })
    await expect(uploadDesktopAgentAttachment(file)).rejects.toMatchObject({ code: 'desktop_update_required' })
    expect(request).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
    if (previous) target.guguDesktop = previous
    else delete target.guguDesktop
  }
})

it('桌面预览的对话和辅助模型使用同一个桌面模型接口', async () => {
  const previous = location.href
  history.replaceState(null, '', '?desktopPreview=1')
  const fetchModels = vi.fn(async (_path: string, init: RequestInit) => {
    const { method } = JSON.parse(String(init.body))
    return Response.json({ ok: true, result: { items: [method] } })
  })
  vi.stubGlobal('fetch', fetchModels)
  try {
    await expect(requestDesktopAgentModel({ action: 'list' })).resolves.toEqual({ items: ['agentModel'] })
    await expect(requestDesktopAuxiliaryModel({ action: 'list' })).resolves.toEqual({ items: ['auxiliaryModel'] })
    expect(fetchModels.mock.calls.map(([path, init]) => [path, JSON.parse(String(init.body))])).toEqual([
      ['/__desktop-preview/agent-model', { method: 'agentModel', args: [{ action: 'list' }] }],
      ['/__desktop-preview/agent-model', { method: 'auxiliaryModel', args: [{ action: 'list' }] }],
    ])
  } finally {
    vi.unstubAllGlobals()
    history.replaceState(null, '', previous)
  }
})

it('桌面斜杠命令读取本机配置和当前运行，停止时使用明确的运行 ID', async () => {
  const target = window as Window & { guguDesktop?: Record<string, unknown> }
  const previous = target.guguDesktop
  const agentSessions = vi.fn(async (command: DesktopAgentSessionCommand) => ({
    ok: true, result: command.action === 'events'
      ? { status: 'running', runId: 'synthetic-run' }
      : command.action === 'readMemory' ? { text: '合成长期记忆' } : { outcome: 'requested' },
  }))
  target.guguDesktop = { agentSessions }
  const mode = { read: vi.fn(async () => false), write: vi.fn(async (enabled: boolean) => enabled) }
  const command = createDesktopChatCommandAccess(mode)
  try {
    expect((await listDesktopChatCommands()).map(item => item.command)).toEqual(['/stop', '/status', '/compact', '/goal', '/new', '/memory', '/forget', '/auto', '/help'])
    await expect(command('/help', null)!()).resolves.toMatchObject({ text: expect.stringContaining('/memory') })
    await expect(command('/mem help', null)!()).resolves.toMatchObject({ text: expect.stringContaining('长期记忆') })
    await expect(command('/help /compact', null)!()).resolves.toMatchObject({ text: expect.stringContaining('整理当前会话上下文') })
    expect(command('/compact', 42)).toBeUndefined()
    expect(command('/goal 整理合成资料', 42)).toBeUndefined()
    await expect(command('/new', 42)!()).resolves.toEqual({ newSession: true })
    expect(agentSessions).not.toHaveBeenCalled()
    expect(command('/unhandled', 42)).toBeUndefined()
    await expect(command('／auto on', 42)!()).resolves.toMatchObject({ automaticModeEnabled: true })
    expect(mode.write).toHaveBeenCalledWith(true)
    await expect(command('/status', 42)!()).resolves.toMatchObject({ text: expect.any(String) })
    await expect(command('/cancel', 42)!()).resolves.toMatchObject({ text: expect.any(String) })
    await expect(command('/mem', null)!()).resolves.toEqual({ text: '合成长期记忆' })
    expect(agentSessions.mock.calls.map(([input]) => input)).toEqual([
      { action: 'events', id: 42, stateOnly: true },
      { action: 'events', id: 42, stateOnly: true },
      { action: 'cancelRun', id: 42, runId: 'synthetic-run' },
      { action: 'readMemory' },
    ])
  } finally {
    if (previous) target.guguDesktop = previous
    else delete target.guguDesktop
  }
})

it('取消 /forget 的确认时只查询匹配范围，没有提交删除', async () => {
  const target = window as Window & { guguDesktop?: Record<string, unknown> }
  const previous = target.guguDesktop
  const agentSessions = vi.fn(async (_command: DesktopAgentSessionCommand) => ({
    ok: true, result: { count: 2, revision: 'synthetic' },
  }))
  target.guguDesktop = { agentSessions }
  const command = createDesktopChatCommandAccess({ read: vi.fn(), write: vi.fn() })
  const dialog = useConfirmDialog()
  try {
    const pending = command('/forget 合成记忆', null)!()
    await vi.waitFor(() => expect(dialog.active.value?.tone).toBe('danger'))
    dialog.settle(false)
    await pending
    expect(agentSessions.mock.calls.map(([item]) => item)).toEqual([{ action: 'forgetMemory', query: '合成记忆' }])
  } finally {
    if (dialog.active.value) dialog.settle(false)
    if (previous) target.guguDesktop = previous
    else delete target.guguDesktop
  }
})

it('桌面技能读取本机资源目录的全部 MCP 工具分页', async () => {
  const first = { name: 'mcp_notes_search', description_short: '搜索笔记', category: 'other', enabled: true }
  const last = { name: 'mcp_notes_read', description_short: '读取笔记', category: 'other', enabled: true }
  const resources = vi.fn()
    .mockResolvedValueOnce({ ok: true, result: { tools: [first], nextOffset: 1 } })
    .mockResolvedValueOnce({ ok: true, result: { tools: [last], nextOffset: null } })
  vi.stubGlobal('guguDesktop', { resources })
  try {
    await expect(desktopSkillsApi.tools()).resolves.toEqual({ tools: [first, last] })
    expect(resources.mock.calls).toEqual([
      [{ domain: 'skills', action: 'tools', offset: 0 }],
      [{ domain: 'skills', action: 'tools', offset: 1 }],
    ])
  } finally {
    vi.unstubAllGlobals()
  }
})


it('桌面流丢失终态时提示连接中断，保留持久发送回执', async () => {
  const operationId = crypto.randomUUID()
  const runId = 'current-run'
  let receive: ((event: DesktopAgentChatEvent) => void) | undefined
  vi.stubGlobal('guguDesktop', {
    onAgentChatEvent(listener: (event: DesktopAgentChatEvent) => void) {
      receive = listener
      return () => {}
    },
    async agentSessions() {
      receive?.({ type: 'session_id', operationId, session_id: 12, user_message_id: 11, run_id: runId })
      return { ok: true, result: [] }
    },
  })
  try {
    const stream = createDesktopChatEventStream({
      action: 'send', id: 12, text: '合成问题', operationId,
    }, new AbortController().signal)
    const wire = await new Response(stream).text()
    expect(wire.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.slice(6)))).toEqual([
      { type: 'session_id', session_id: 12, user_message_id: 11, run_id: runId },
      { type: 'error', message: '聊天事件连接已中断，可重新打开会话查看', delivery_interrupted: true },
    ])
  } finally {
    vi.unstubAllGlobals()
  }
})
