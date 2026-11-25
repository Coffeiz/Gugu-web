import { expect, it, vi } from 'vitest'
import { DESKTOP_CHANNELS, type DesktopAgentEventPage } from '@gugu/core/desktop'
import type { createDesktopAgentModelService } from '../src/main/agent/model.js'
import { agentSessionHandlers } from '../src/main/agent/ipc.js'

it('桌面会话续看持续到运行终态或调用方断开，不受固定请求时限截断', async () => {
  const request = vi.fn(async <T,>(method: string): Promise<T> => {
    if (method === 'agent.sessions.events') return {
      runId: 'synthetic-run', events: [], cursor: 0, status: 'running', hasMore: false,
    } as DesktopAgentEventPage as T
    return { messages: [] } as T
  })
  const changed = vi.fn(() => () => {})
  const handlers = agentSessionHandlers({ request, onAgentRunChanged: changed },
    {} as ReturnType<typeof createDesktopAgentModelService>)
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort())
  const operationId = '00000000-0000-4000-8000-000000000001'
  const operation = handlers[DESKTOP_CHANNELS.agentSessions]({
    action: 'resume', id: 1, runId: 'synthetic-run', operationId,
  })
  const settled = vi.fn()
  void operation.then(settled, settled)

  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('agent.sessions.events', expect.anything()))
    expect(timeout).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()
    await handlers[DESKTOP_CHANNELS.agentSessions]({ action: 'disconnect', operationId })
    await expect(operation).rejects.toMatchObject({ code: 'closed' })
    expect(request).not.toHaveBeenCalledWith('agent.sessions.cancelRun', expect.anything())
  } finally {
    timeout.mockRestore()
  }
})

it('桌面待发送队列使用 Core SQLite 命令并保留操作标识', async () => {
  const request = vi.fn(async () => ({ claimToken: 'synthetic-claim', reason: undefined }))
  const handlers = agentSessionHandlers({ request }, {} as ReturnType<typeof createDesktopAgentModelService>)
  const operationId = '00000000-0000-4000-8000-000000000002'
  await handlers[DESKTOP_CHANNELS.agentSessions]({
    action: 'queue', queueAction: 'claim', queueId: 'session-7', sessionId: 7, key: 12, operationId,
  })
  expect(request).toHaveBeenCalledWith('agent.sessions.queue', {
    action: 'claim', queue_id: 'session-7', session_id: 7, key: 12,
  }, operationId)
})

it('桌面运行被 Core 确认后立即发送 Web SSE 的 session_id 事件', async () => {
  const request = vi.fn(async <T,>(method: string): Promise<T> => {
    if (method === 'agent.sessions.startRun') return { run_id: 'synthetic-run', session_id: 7, user_message_id: 41 } as T
    if (method === 'agent.sessions.events') return {
      runId: 'synthetic-run', events: [
        { type: 'tool_done', name: 'web_search', status: 'success' },
        { type: 'interaction_required', prompt_id: 4, core_run_id: 'synthetic-run', options: [] },
      ], cursor: 2, status: 'waiting', hasMore: false,
    } as DesktopAgentEventPage as T
    return { messages: [] } as T
  })
  const model = { resolveRunModelSelection: vi.fn(async () => ({ id: 'model-1', config: {} })) } as unknown as ReturnType<typeof createDesktopAgentModelService>
  const handlers = agentSessionHandlers({ request }, model)
  const events: unknown[] = []
  const queueClaim = { key: 12, token: 'synthetic-claim' }
  await handlers[DESKTOP_CHANNELS.agentSessions]({ action: 'send', id: 7, text: '你好', operationId:
    '00000000-0000-4000-8000-000000000003', stream: true, queueClaim }, event => events.push(event))
  expect(request).toHaveBeenCalledWith('agent.sessions.startRun', expect.objectContaining({ id: 7, queueClaim }))
  await handlers[DESKTOP_CHANNELS.agentSessions]({ action: 'events', id: 7, stateOnly: true })
  expect(request).toHaveBeenCalledWith('agent.sessions.events', { id: 7, stateOnly: true })
  expect(events[0]).toMatchObject({ type: 'session_id', session_id: 7, user_message_id: 41, run_id: 'synthetic-run' })
  expect(events.slice(1)).toEqual([
    { type: 'projected', operationId: '00000000-0000-4000-8000-000000000003', event: { type: 'tool_done', name: 'web_search', status: 'success' } },
    { type: 'projected', operationId: '00000000-0000-4000-8000-000000000003', event: { type: 'interaction_required', prompt_id: 4, core_run_id: 'synthetic-run', options: [] } },
  ])
})

it('桌面 /workspace 命令通过 Core 绑定当前会话并投影完成消息', async () => {
  const directoryId = 'desktop:11111111-1111-4111-8111-111111111111'
  const request = vi.fn(async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
    if (method === 'agent.sessions.setWorkspace') return { workspace: {
      workspace_id: directoryId, workspace_name: '合成目录',
    } } as T
    if (method === 'agent.sessions.append') return { userMessageId: 43 } as T
    if (method === 'agent.sessions.messages') return [] as T
    throw new Error(`unexpected request ${method} ${JSON.stringify(params)}`)
  })
  const model = { resolveRunModelSelection: vi.fn() } as unknown as ReturnType<typeof createDesktopAgentModelService>
  const handlers = agentSessionHandlers({ request }, model)
  const events: unknown[] = []
  const operationId = '00000000-0000-4000-8000-000000000004'

  await handlers[DESKTOP_CHANNELS.agentSessions]({ action: 'send', id: 7, text: '/workspace bind 合成目录',
    operationId, clientMessageId: 'workspace-client', stream: true }, event => events.push(event))

  expect(request).toHaveBeenCalledWith('agent.sessions.setWorkspace', { id: 7, action: 'bind', directoryId: '合成目录' })
  expect(request).toHaveBeenCalledWith('agent.sessions.append', {
    id: 7, text: '/workspace bind 合成目录', reply: '已将当前会话绑定到工作区「合成目录」。', clientId: 'workspace-client',
  }, operationId)
  expect(events).toEqual([
    { type: 'session_id', operationId, session_id: 7, user_message_id: 43, client_message_id: 'workspace-client' },
    { type: 'content', operationId, text: '已将当前会话绑定到工作区「合成目录」。' },
    { type: 'projected', operationId, event: { type: 'done', command_reply: true } },
  ])
})


it('桌面内部等待期间保留原运行的连接并继续接收回复', async () => {
  const runId = 'synthetic-run'
  const request = vi.fn(async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
    if (method === 'agent.sessions.messages') return [] as T
    if (method !== 'agent.sessions.events') throw new Error('非预期的桌面请求')
    const waiting = params?.after === 0
    return {
      runId, cursor: waiting ? 1 : 2, status: waiting ? 'waiting' : 'completed', hasMore: false,
      events: waiting ? [] : [{ type: 'done', run_id: runId }],
    } as DesktopAgentEventPage as T
  })
  let notify: ((id: number, runId: string) => void) | undefined
  const handlers = agentSessionHandlers({ request, onAgentRunChanged(listener) {
    notify = listener
    return () => {}
  } }, {} as ReturnType<typeof createDesktopAgentModelService>)
  const connection = new AbortController()
  const events = vi.fn()
  const operation = handlers[DESKTOP_CHANNELS.agentSessions]({
    action: 'resume', id: 1, runId, operationId: crypto.randomUUID(),
  }, events, connection.signal)
  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('agent.sessions.events', { id: 1, runId, after: 0 }))
    expect(request).not.toHaveBeenCalledWith('agent.sessions.messages', { id: 1 })
    notify?.(1, runId)
    await expect(operation).resolves.toEqual([])
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ event: { type: 'done', run_id: runId } }))
  } finally {
    connection.abort()
    await operation.catch(() => {})
  }
})

it('原生聊天 IPC 在请求结束前向对应窗口发送文本和工具事件', async () => {
  const { registerDesktopIpc } = await import('../src/main/ipc/register.js')
  const register = vi.fn<Pick<import('electron').IpcMain, 'handle'>['handle']>()
  let complete!: () => void
  const pending = new Promise<void>(resolve => { complete = resolve })
  const action = vi.fn(async (_command: unknown, publish: unknown) => {
    const send = publish as (event: unknown) => void
    send({ type: 'content', text: '部分回复' })
    send({ type: 'projected', event: { type: 'tool_done' } })
    await pending
  })
  registerDesktopIpc({ handle: register }, { [DESKTOP_CHANNELS.agentSessions]: action }, {
    authorize: () => true, onResult: () => {},
  })
  const invoke = register.mock.calls[0]![1]
  const panel = { send: vi.fn(), isDestroyed: () => false }
  const result = invoke({ sender: panel } as unknown as import('electron').IpcMainInvokeEvent, { action: 'send' })
  try {
    await vi.waitFor(() => expect(panel.send.mock.calls).toEqual([
      [DESKTOP_CHANNELS.agentChatEvent, { type: 'content', text: '部分回复' }],
      [DESKTOP_CHANNELS.agentChatEvent, { type: 'projected', event: { type: 'tool_done' } }],
    ]))
  } finally {
    complete()
    await result
  }
})
