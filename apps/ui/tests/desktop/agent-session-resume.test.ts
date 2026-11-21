import { effectScope } from 'vue'
import { expect, it, vi } from 'vitest'
import type { DesktopAgentChatEvent, DesktopAgentSessionCommand } from '@gugu/core/desktop'
import { useDesktopAgentSessions } from '../../src/desktop/shell/composables/useDesktopAgentSessions'

it('打开会话自动续看原运行，切走后丢弃增量，停止时只取消本轮', async () => {
  const createdAt = '2026-01-01T00:00:00Z'
  const sessions = [1, 2].map(id => ({ id, title: `合成会话 ${id}`, updatedAt: createdAt }))
  const messages = [{ id: 1, role: 'user', text: '合成问题', createdAt }]
  const listeners = new Set<(event: DesktopAgentChatEvent) => void>()
  let resolveResume!: (value: unknown) => void
  const invoke = vi.fn(async (command: DesktopAgentSessionCommand) => {
    switch (command.action) {
      case 'list': return { ok: true, result: sessions }
      case 'events': return { ok: true, result: { runId: command.id === 1 ? 'synthetic-run' : null, status: 'running' } }
      case 'history': return { ok: true, result: { messages, pagination: { hasMore: false, oldestId: 1 } } }
      case 'resume': return new Promise(resolve => { resolveResume = resolve })
      case 'cancelRun': return { ok: true, result: { ok: true, outcome: 'requested' } }
      default: throw new Error('测试不发送新消息')
    }
  })
  vi.stubGlobal('guguDesktop', {
    agentSessions: invoke,
    onAgentChatEvent(listener: (event: DesktopAgentChatEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })
  const scope = effectScope()
  try {
    const chat = scope.run(() => useDesktopAgentSessions(() => {}))!
    await chat.loadSessions()
    await chat.loadSession(1)
    const resume = invoke.mock.calls.find(([command]) => command.action === 'resume')?.[0]
    expect(resume).toMatchObject({ id: 1, runId: 'synthetic-run' })
    if (resume?.action !== 'resume') throw new Error('续看命令缺失')
    for (const listener of listeners) listener({ type: 'projected', operationId: resume.operationId, event: { type: '_context_compaction', phase: 'started' } })
    expect(chat.streamStatus.value).not.toBe('')
    for (const listener of listeners) listener({ type: 'projected', operationId: resume.operationId, event: { type: '_context_compaction', phase: 'completed' } })
    expect(chat.streamStatus.value).toBe('')
    for (const listener of listeners) listener({ type: 'projected', operationId: resume.operationId, event: { type: 'retry', attempt: 1, max_retries: 3, next_retry_in: 2 } })
    expect(chat.streamStatus.value).toContain('1/3')
    for (const listener of listeners) listener({ type: 'content', operationId: resume.operationId, text: '合成增量' })
    expect(chat.messages.value.map(message => message.text)).toEqual(['合成问题', '合成增量'])
    expect(chat.streamStatus.value).toBe('')
    const tool = {
      kind: 'tool' as const, eventId: 'synthetic-event', runId: resume.runId, roundId: 'synthetic-round',
      sequence: 1, anchorMessageId: '1', timelineOrder: '1000001', createdAt, updatedAt: createdAt,
      toolCallId: 'synthetic-call', toolName: 'search_memory', toolStatus: 'running', toolLabelOverride: '合成记忆检索中',
    }
    for (const listener of listeners) listener({ type: 'projected', operationId: resume.operationId, event: { type: 'display_event', item: tool } })
    expect(chat.streamStatus.value).toBe('合成记忆检索中')
    for (const listener of listeners) listener({ type: 'projected', operationId: resume.operationId, event: { type: 'display_event',
      item: { ...tool, toolStatus: 'success', updatedAt: '2026-01-01T00:00:01Z' } } })
    expect(chat.streamStatus.value).toBe('')
    expect(chat.messages.value.filter(message => message.role === 'tool')).toEqual([
      expect.objectContaining({ toolName: 'search_memory', toolStatus: 'success' }),
    ])
    for (const [index, text] of ['合成第一轮', '合成第二轮'].entries()) {
      for (const listener of listeners) listener({ type: 'projected', operationId: resume.operationId, event: { type: 'display_event',
        item: { kind: 'assistant', eventId: `synthetic-reply-${index}`, runId: resume.runId,
          roundId: `synthetic-round-${index}`, sequence: index + 2,
          anchorMessageId: '1', timelineOrder: String(1000002 + index), createdAt, updatedAt: createdAt, text } } })
      for (const listener of listeners) listener({ type: 'content', operationId: resume.operationId, text })
    }
    expect(chat.messages.value.filter(message => message.role === 'ai').map(({ text, streaming }) => ({ text, streaming }))).toEqual([
      { text: '合成第一轮', streaming: false }, { text: '合成第二轮', streaming: true },
    ])
    await chat.stopStreaming()
    expect(invoke).toHaveBeenCalledWith({ action: 'cancelRun', id: 1, runId: 'synthetic-run' })
    await chat.loadSession(2)
    expect(listeners.size).toBe(0)
    resolveResume({ ok: true, result: messages })
    expect(chat.messages.value.map(message => message.text)).toEqual(['合成问题'])
    expect(invoke.mock.calls.some(([command]) => command.action === 'send')).toBe(false)
  } finally {
    scope.stop()
    vi.unstubAllGlobals()
  }
})

it('模型失败后保留已提交消息，不把同一条消息恢复为待发送草稿', async () => {
  const at = '2026-01-01T00:00:00Z'
  let saved: { id: number; role: string; text: string; createdAt: string; clientMessageId: string; runOutcome: { status: string } } | undefined
  vi.stubGlobal('guguDesktop', {
    onAgentChatEvent: () => () => {},
    async agentSessions(command: DesktopAgentSessionCommand) {
      if (command.action === 'list') return { ok: true, result: [{ id: 1, title: '合成会话', updatedAt: at }] }
      if (command.action === 'events') return { ok: true, result: { runId: null, status: 'idle' } }
      if (command.action === 'history') return { ok: true, result: {
        messages: saved ? [saved] : [], pagination: { hasMore: false, oldestId: saved?.id ?? null },
      } }
      if (command.action === 'send') {
        saved = { id: 1, role: 'user', text: command.text, createdAt: at, clientMessageId: command.operationId, runOutcome: { status: 'failed' } }
        return { ok: false, error: { code: 'model_unavailable', message: '合成模型错误' } }
      }
      throw new Error('测试命令无效')
    },
  })
  const scope = effectScope()
  try {
    const chat = scope.run(() => useDesktopAgentSessions(() => {}))!
    await chat.loadSessions()
    await chat.loadSession(1)
    chat.inputText.value = '合成已提交问题'
    await chat.send()
    expect(chat.inputText.value).toBe('')
    expect(chat.messages.value).toEqual([expect.objectContaining({ dbId: 1, text: '合成已提交问题', runOutcome: { status: 'failed' } })])
    expect(chat.sendFailed.value).toBe('合成模型错误')
  } finally {
    scope.stop()
    vi.unstubAllGlobals()
  }
})

it('切回仍在发送的会话，恢复最新工具卡片且只停止当前会话', async () => {
  const createdAt = '2026-01-01T00:00:00Z'
  const sessions = [1, 2].map(id => ({ id, title: `合成会话 ${id}`, updatedAt: createdAt }))
  const listeners = new Set<(event: DesktopAgentChatEvent) => void>()
  let finish!: (result: unknown) => void
  const invoke = vi.fn(async (command: DesktopAgentSessionCommand) => {
    switch (command.action) {
      case 'list': return { ok: true, result: sessions }
      case 'events': return { ok: true, result: { runId: null, status: 'idle' } }
      case 'history': return { ok: true, result: { messages: [], pagination: { hasMore: false, oldestId: null } } }
      case 'send': return new Promise(resolve => { finish = resolve })
      case 'cancel': return { ok: true, result: null }
    }
  })
  vi.stubGlobal('guguDesktop', {
    agentSessions: invoke,
    onAgentChatEvent(listener: (event: DesktopAgentChatEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })
  const scope = effectScope()
  try {
    const chat = scope.run(() => useDesktopAgentSessions(() => {}))!
    await chat.loadSessions()
    await chat.loadSession(1)
    chat.inputText.value = '合成工具请求'
    const pending = chat.send()
    const send = invoke.mock.calls.find(([command]) => command.action === 'send')?.[0]
    if (send?.action !== 'send') throw new Error('发送命令缺失')
    await chat.loadSession(2)
    await chat.stopStreaming()
    expect(invoke.mock.calls.some(([command]) => command.action === 'cancel')).toBe(false)
    const item = {
      kind: 'tool' as const, eventId: 'synthetic-event', runId: 'synthetic-run', roundId: 'synthetic-round',
      sequence: 1, anchorMessageId: '1', timelineOrder: '1000001', createdAt, updatedAt: createdAt,
      toolCallId: 'synthetic-call', toolName: 'web_search', toolStatus: 'running',
    }
    for (const listener of listeners) {
      listener({ type: 'projected', operationId: send.operationId, event: { type: 'display_event', item } })
      listener({ type: 'projected', operationId: send.operationId, event: { type: 'display_event',
        item: { ...item, toolStatus: 'success', updatedAt: '2026-01-01T00:00:01Z' } } })
    }
    expect(chat.messages.value).toEqual([])
    await chat.loadSession(1)
    expect(chat.messages.value.filter(message => message.role === 'tool')).toEqual([
      expect.objectContaining({ toolName: 'web_search', toolStatus: 'success' }),
    ])
    await chat.stopStreaming()
    expect(invoke).toHaveBeenCalledWith({ action: 'cancel', id: 1, operationId: send.operationId })
    finish({ ok: true, result: [] })
    await pending
  } finally {
    scope.stop()
    vi.unstubAllGlobals()
  }
})

it('当前会话保持打开时，提问到期后重读运行和历史', async () => {
  vi.useFakeTimers()
  const at = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 1000).toISOString()
  const invoke = vi.fn(async (command: DesktopAgentSessionCommand) => {
    if (command.action === 'list') return { ok: true, result: [{ id: 1, title: '合成会话', updatedAt: at }] }
    if (command.action === 'history') return { ok: true, result: { messages: [], pagination: { hasMore: false, oldestId: null } } }
    if (command.action === 'events') {
      const expired = Date.now() >= Date.parse(expiresAt)
      return { ok: true, result: { runId: 'synthetic-run', status: expired ? 'failed' : 'waiting', events: [{
        type: 'interaction_required', core_run_id: 'synthetic-run', prompt_id: 3, kind: 'choice',
        title: '合成提示', created_at: at, expires_at: expiresAt, resolved: expired, expired,
        options: expired ? [] : [{ id: 'a', label: '选项 A', token: 'synthetic-token' }],
      }] } }
    }
    throw new Error('测试命令无效')
  })
  vi.stubGlobal('guguDesktop', { agentSessions: invoke })
  const scope = effectScope()
  try {
    const chat = scope.run(() => useDesktopAgentSessions(() => {}))!
    await chat.loadSessions()
    await chat.loadSession(1)
    expect(chat.messages.value[0]?.interaction).toMatchObject({ resolved: false })
    await vi.advanceTimersByTimeAsync(999)
    expect(invoke.mock.calls.filter(([command]) => command.action === 'events')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(invoke).toHaveBeenCalledWith({ action: 'events', id: 1, runId: 'synthetic-run' })
    expect(chat.messages.value[0]?.interaction).toMatchObject({ resolved: true, expired: true, options: [] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(invoke.mock.calls.filter(([command]) => command.action === 'events')).toHaveLength(2)
  } finally {
    scope.stop()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})

it('交互回复断线时核对 Core，并用同一请求标识重试', async () => {
  const createdAt = '2026-01-01T00:00:00Z'
  const answers: string[] = []
  let complete = false
  const invoke = vi.fn(async (command: DesktopAgentSessionCommand) => {
    if (command.action === 'list') return { ok: true, result: [{ id: 1, title: '合成会话', updatedAt: createdAt }] }
    if (command.action === 'history') return { ok: true, result: {
      messages: complete ? [{ id: 2, role: 'assistant', text: '合成已恢复回复', createdAt }] : [],
      pagination: { hasMore: false, oldestId: null },
    } }
    if (command.action === 'events') return { ok: true, result: {
      runId: 'synthetic-run', status: complete ? 'completed' : 'waiting', events: [{
        type: 'interaction_required', core_run_id: 'synthetic-run', prompt_id: 3, kind: 'choice',
        title: '合成提示', created_at: createdAt, resolved: complete,
        options: complete ? [] : [{ id: 'a', label: '选项 A', token: 'synthetic-token' }],
      }],
    } }
    if (command.action === 'respond' && 'operationId' in command) {
      answers.push(command.operationId)
      complete = answers.length === 2
      return { ok: false, error: { code: 'closed', message: '合成断线' } }
    }
    throw new Error('测试命令无效')
  })
  vi.stubGlobal('guguDesktop', { agentSessions: invoke })
  const scope = effectScope()
  try {
    const chat = scope.run(() => useDesktopAgentSessions(() => {}))!
    await chat.loadSessions()
    await chat.loadSession(1)
    await chat.respond(chat.messages.value[0]!, { token: 'synthetic-token' })
    expect(chat.sendFailed.value).toBe('合成断线')
    await chat.respond(chat.messages.value[0]!, { token: 'synthetic-token' })
    expect(answers).toEqual([answers[0], answers[0]])
    expect(chat.sendFailed.value).toBe('')
    expect(chat.messages.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ interaction: expect.objectContaining({ resolved: true }) }),
      expect.objectContaining({ role: 'ai', text: '合成已恢复回复' }),
    ]))
  } finally {
    scope.stop()
    vi.unstubAllGlobals()
  }
})

it('已保存的消息断线时自动续看当前运行', async () => {
  const createdAt = '2026-01-01T00:00:00Z'
  let savedId: string | undefined
  let completed = false
  const invoke = vi.fn(async (command: DesktopAgentSessionCommand) => {
    if (command.action === 'list') return { ok: true, result: [{ id: 1, title: '合成会话', updatedAt: createdAt }] }
    if (command.action === 'history') return { ok: true, result: {
      messages: savedId ? [
        { id: 1, role: 'user', text: '合成请求', createdAt, clientMessageId: savedId, runId: 'synthetic-run' },
        ...(completed ? [{ id: 2, role: 'assistant', text: '合成续看完成', createdAt }] : []),
      ] : [],
      pagination: { hasMore: false, oldestId: savedId ? 1 : null },
    } }
    if (command.action === 'events') return { ok: true, result: {
      runId: savedId ? 'synthetic-run' : null, status: completed ? 'completed' : savedId ? 'running' : 'idle', events: [],
    } }
    if (command.action === 'send') {
      savedId = command.operationId
      return { ok: false, error: { code: 'closed', message: '合成断线' } }
    }
    if (command.action === 'resume') {
      completed = true
      return { ok: true, result: [] }
    }
    throw new Error('测试命令无效')
  })
  vi.stubGlobal('guguDesktop', { agentSessions: invoke, onAgentChatEvent: () => () => {} })
  const scope = effectScope()
  try {
    const chat = scope.run(() => useDesktopAgentSessions(() => {}))!
    await chat.loadSessions()
    await chat.loadSession(1)
    chat.inputText.value = '合成请求'
    await chat.send()
    await vi.waitFor(() => expect(chat.messages.value.map(item => item.text)).toEqual(['合成请求', '合成续看完成']))
    expect(invoke.mock.calls.filter(([command]) => command.action === 'send')).toHaveLength(1)
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'resume', id: 1, runId: 'synthetic-run' }))
    expect(chat.inputText.value).toBe('')
    expect(chat.sendFailed.value).toBe('')
  } finally {
    scope.stop()
    vi.unstubAllGlobals()
  }
})
