import { parseAgentCommand } from '@gugu/core/agent/commands/menu'
import { isAgentCommandHelpArgument } from '@gugu/core/agent/commands/help'
import { setTimeout as delay } from 'node:timers/promises'
import { DESKTOP_CHANNELS, type DesktopAgentChatEvent, type DesktopAgentEventPage } from '@gugu/core/desktop'
import type { RagQueryEmbeddingSettings } from '@gugu/core/agent/rag'
import { DesktopError } from '../core-host.js'
import type { createDesktopAgentModelService } from './model.js'
import type { IpcHandlers, IpcHost } from '../ipc/types.js'

function desktopWorkspaceCommand(argument: string): { action: 'list' | 'show' | 'bind' | 'unlink'; directoryId?: string } | null {
  const value = argument.trim()
  if (!value || value === 'list' || value === '列表') return { action: 'list' }
  if (value === 'show' || value === '查看' || value === '当前') return { action: 'show' }
  if (value === 'unlink' || value === '解除绑定' || value === '取消绑定') return { action: 'unlink' }
  const directoryId = value.startsWith('bind ') ? value.slice(5).trim() : value
  return /^desktop:[a-f0-9-]{36}$/u.test(directoryId) ? { action: 'bind', directoryId } : null
}

function desktopWorkspaceReply(action: 'list' | 'show' | 'bind' | 'unlink', result: unknown): string {
  const value = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {}
  if (action === 'list') {
    const workspaces = Array.isArray(value.workspaces) ? value.workspaces as Array<Record<string, unknown>> : []
    return workspaces.length ? `可绑定的工作区：\n${workspaces.map(row => `- ${String(row.name)}（${String(row.id)}）`).join('\n')}` : '当前没有可绑定的工作区。'
  }
  if (action === 'unlink') return '已解除当前会话的工作区绑定。'
  const workspace = value.workspace && typeof value.workspace === 'object' ? value.workspace as Record<string, unknown> : null
  if (!workspace) return action === 'show' ? '当前会话未绑定工作区。' : '工作区绑定失败。'
  return action === 'show' ? `当前会话绑定的工作区：${String(workspace.workspace_name)}（${String(workspace.workspace_id)}）`
    : `已将当前会话绑定到工作区「${String(workspace.workspace_name)}」。`
}

export function agentSessionHandlers(host: IpcHost, model: ReturnType<typeof createDesktopAgentModelService>,
  publish?: (event: DesktopAgentChatEvent) => void,
  resolveEmbedding?: () => Promise<RagQueryEmbeddingSettings | undefined>,
  cleanupAttachments?: (attachIds: readonly string[]) => Promise<void>,
): IpcHandlers {
  const sending = new Map<number, { operationId: string; controller: AbortController; runId?: string }>()
  const opening = new Map<string, AbortController>()
  const observers = new Map<string, AbortController>()
  async function observeRun(id: number, runId: string, operationId: string,
    streaming: ((event: DesktopAgentChatEvent) => void) | undefined, connection: unknown) {
    const observed = connection instanceof AbortSignal ? connection : undefined
    // 和 Web SSE 一样，持续观察直到 Run 终态或 Renderer 断开，不用固定时限截断长任务。
    if (observers.has(operationId)) throw new DesktopError('conflict', '聊天事件连接已存在')
    const observer = new AbortController()
    observers.set(operationId, observer)
    const signal = observed ? AbortSignal.any([observed, observer.signal]) : observer.signal
    const assistantText = new Map<string, string>()
    let cursor = 0
    let error: string | undefined
    let changed = new AbortController()
    const unsubscribe = host.onAgentRunChanged?.((sessionId, changedRunId) => {
      if (sessionId === id && changedRunId === runId) changed.abort()
    })
    try {
      while (!signal.aborted) {
        changed = new AbortController()
        const page = await host.request<DesktopAgentEventPage>('agent.sessions.events', { id, runId, after: cursor })
        cursor = page.cursor
        for (const event of page.events) {
          if (event.type === 'error' && typeof event.message === 'string') error = event.message
          if (streaming && !signal.aborted) {
            if (event.type === 'session_id' && event.session_id === id && typeof event.user_message_id === 'number')
              streaming({ type: 'session_id', operationId, session_id: id, user_message_id: event.user_message_id,
                ...(typeof event.client_message_id === 'string' ? { client_message_id: event.client_message_id } : {}) })
            if (event.type === 'content' && typeof event.text === 'string')
              streaming({ type: 'content', operationId, text: event.text })
          }
          if (streaming && !signal.aborted && ['round_start', 'display_event', 'tool_done', 'interaction_required',
            'interaction_resolved', '_context_compaction', 'retry', 'notice', 'error', 'done', 'session_title', 'session_goal']
            .includes(event.type)) streaming({ type: 'projected', operationId, event })
          if (event.type !== 'display_event' || !event.item || typeof event.item !== 'object') continue
          const item = event.item as { kind?: string; eventId?: string; text?: string }
          if (item.kind !== 'assistant' || typeof item.eventId !== 'string' || typeof item.text !== 'string') continue
          const previous = assistantText.get(item.eventId) ?? ''
          assistantText.set(item.eventId, item.text)
          if (streaming && !signal.aborted && item.text.startsWith(previous) && item.text.length > previous.length)
            streaming({ type: 'content', operationId, text: item.text.slice(previous.length) })
        }
        if (page.hasMore) continue
        if (page.status === 'cancelled') throw new DesktopError('cancelled', '操作已取消')
        if (['failed', 'startup_failed', 'unknown'].includes(page.status))
          throw new DesktopError('model_unavailable', error ?? '生成失败，请稍后重试')
        if (page.status === 'completed' || page.status === 'waiting'
          || page.events.some(event => event.type === 'done' && event.interrupted === true))
          return host.request('agent.sessions.messages', { id })
        const wakeSignal = AbortSignal.any([signal, changed.signal])
        await delay(10_000, undefined, { signal: wakeSignal }).catch(() => {})
      }
      throw new DesktopError('closed', '聊天事件连接已关闭，可重新打开会话查看')
    } finally {
      observers.delete(operationId)
      unsubscribe?.()
    }
  }
  return {
    [DESKTOP_CHANNELS.agentSessions]: async (command, responseSink, connection) => {
      if (command && typeof command === 'object' && 'action' in command) {
        if (command.action === 'disconnect' && 'operationId' in command && typeof command.operationId === 'string') {
          opening.get(command.operationId)?.abort()
          observers.get(command.operationId)?.abort()
          return null
        }
        if (command.action === 'cancel' && 'id' in command && typeof command.id === 'number'
          && 'operationId' in command) {
          const active = sending.get(command.id)
          if (active && active.operationId === command.operationId) {
            active.controller.abort()
            if (active.runId) await host.request('agent.sessions.cancelRun', { id: command.id, runId: active.runId })
          }
          return null
        }
        if (command.action === 'send' && 'id' in command && typeof command.id === 'number' && Number.isSafeInteger(command.id) && command.id > 0
          && 'text' in command && typeof command.text === 'string' && Buffer.byteLength(command.text) <= 12_000
          && 'operationId' in command && typeof command.operationId === 'string' && /^[0-9a-f-]{36}$/i.test(command.operationId)) {
          const { id, text, operationId } = command
          const locale = 'locale' in command ? command.locale : undefined
          const clientMessageId = 'clientMessageId' in command ? command.clientMessageId : undefined
          if (clientMessageId !== undefined && (typeof clientMessageId !== 'string' || !/^[A-Za-z0-9:_-]{1,64}$/.test(clientMessageId)))
            throw new DesktopError('invalid_request', '消息标识无效')
          const modelId = 'modelId' in command ? command.modelId : undefined
          if (modelId !== undefined && (typeof modelId !== 'string' || !modelId || modelId.length > 80))
            throw new DesktopError('invalid_request', '模型选择无效')
          const attachments = 'attachments' in command ? command.attachments ?? [] : []
          const references = 'references' in command ? command.references ?? [] : []
          const queueClaim = 'queueClaim' in command ? command.queueClaim : undefined
          if (!Array.isArray(attachments) || attachments.length > 32
            || attachments.some(id => typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)))
            throw new DesktopError('invalid_request', '附件列表无效')
          if (!Array.isArray(references) || references.length > 50
            || references.some(ref => !ref || typeof ref.type !== 'string' || typeof ref.label !== 'string'
              || ref.label.length > 255 || !(typeof ref.id === 'string' || (typeof ref.id === 'number' && Number.isSafeInteger(ref.id)))))
            throw new DesktopError('invalid_request', '引用列表无效')
          if (!text.trim() && !attachments.length && !references.length)
            throw new DesktopError('invalid_request', '请填写消息或添加附件或引用')
          if (sending.has(id)) throw new DesktopError('busy', '正在等待本会话回复')
          const controller = new AbortController()
          const sink = typeof responseSink === 'function' ? responseSink as (event: DesktopAgentChatEvent) => void : publish
          const streaming = 'stream' in command && command.stream === true && sink
          const active: { operationId: string; controller: AbortController; runId?: string } = { operationId, controller }
          if (opening.has(operationId)) throw new DesktopError('conflict', '聊天事件连接已存在')
          const delivery = new AbortController()
          opening.set(operationId, delivery)
          const deliverySignal = connection instanceof AbortSignal
            ? AbortSignal.any([connection, delivery.signal]) : delivery.signal
          sending.set(id, active)
          try {
            const slash = parseAgentCommand(text)
            if (slash?.recognized && slash.name === 'workspace' && !attachments.length && !references.length) {
              const workspaceCommand = desktopWorkspaceCommand(slash.argument)
              if (workspaceCommand) {
                const params = { id, action: workspaceCommand.action, ...(workspaceCommand.directoryId ? { directoryId: workspaceCommand.directoryId } : {}) }
                const result = workspaceCommand.action === 'bind' || workspaceCommand.action === 'unlink'
                  ? await host.request('agent.sessions.setWorkspace', params)
                  : await host.request('agent.sessions.workspace', params)
                const reply = desktopWorkspaceReply(workspaceCommand.action, result)
                const appended = await host.request<{ userMessageId?: number }>('agent.sessions.append', { id, text, reply }, operationId)
                if (streaming && !deliverySignal.aborted) {
                  streaming({ type: 'session_id', operationId, session_id: id,
                    ...(Number.isSafeInteger(appended.userMessageId) ? { user_message_id: appended.userMessageId } : {}) })
                  streaming({ type: 'content', operationId, text: reply })
                  streaming({ type: 'projected', operationId, event: { type: 'done' } })
                }
                return host.request('agent.sessions.messages', { id })
              }
            }
            if (slash?.recognized && slash.name === 'compact' && !isAgentCommandHelpArgument(slash.argument)
              && !attachments.length && !references.length) {
              const config = await model.resolveRunModel()
              if (controller.signal.aborted) throw new DesktopError('cancelled', '操作已取消')
              const { operation } = await host.request<{ operation: string }>('agent.sessions.compact', {
                id, model: config, text: text.trim(), clientId: clientMessageId ?? operationId, ...(queueClaim ? { queueClaim } : {}),
              })
              active.runId = operation
              if (controller.signal.aborted) await host.request('agent.sessions.cancelRun', { id, runId: operation })
              return await observeRun(id, operation, operationId, streaming || undefined, deliverySignal)
            }
            const selection = await model.resolveRunModelSelection(modelId)
            const embedding = await resolveEmbedding?.()
            if (controller.signal.aborted) throw new DesktopError('cancelled', '操作已取消')
            const started = await host.request<{ run_id: string; session_id?: number; user_message_id?: number; client_message_id?: string }>('agent.sessions.startRun', {
              id, text: text.trim(), clientId: clientMessageId ?? operationId, model: selection.config, modelId: selection.id,
              attachments, references, ...(locale === undefined ? {} : { locale }), ...(queueClaim !== undefined ? { queueClaim } : {}), interactive: Boolean(streaming), ...(embedding ? { embedding } : {}),
            })
            const { run_id: runId } = started
            active.runId = runId
            if (streaming && !deliverySignal.aborted && started.session_id === id) streaming({ type: 'session_id', operationId,
              session_id: id,
              ...(Number.isSafeInteger(started.user_message_id) && started.user_message_id! > 0
                ? { user_message_id: started.user_message_id } : {}),
              run_id: runId,
              ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
            })
            if (controller.signal.aborted) await host.request('agent.sessions.cancelRun', { id, runId })
            return await observeRun(id, runId, operationId, streaming || undefined, deliverySignal)
          } finally {
            opening.delete(operationId)
            sending.delete(id)
          }
        }
        if (command.action === 'resume' && 'id' in command && typeof command.id === 'number'
          && 'runId' in command && typeof command.runId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(command.runId)
          && 'operationId' in command && typeof command.operationId === 'string' && /^[0-9a-f-]{36}$/i.test(command.operationId)) {
          const sink = typeof responseSink === 'function' ? responseSink as (event: DesktopAgentChatEvent) => void : publish
          return observeRun(command.id, command.runId, command.operationId, sink, connection)
        }
        if ((command.action === 'rename' || command.action === 'delete') && 'id' in command
          && 'operationId' in command && typeof command.operationId === 'string') {
          const { id, operationId } = command
          if (command.action === 'rename' && 'title' in command)
            return host.request('agent.sessions.rename', { id, title: command.title }, operationId)
          if (command.action === 'delete') {
            if (typeof id === 'number' && sending.has(id)) throw new DesktopError('conflict', '请先停止会话中正在运行的任务')
            const attachments = await host.request<string[]>('agent.attachments.forSession', { id })
            const result = await host.request('agent.sessions.delete', { id }, operationId)
            if (Array.isArray(attachments)) await cleanupAttachments?.(attachments)
            return result
          }
        }
        if (command.action === 'forgetMemory' && 'query' in command)
          return host.request('agent.memory.forget', { query: command.query, ...('revision' in command ? { revision: command.revision } : {}) })
        if (command.action === 'readMemory') return host.request('agent.memory.read')
        if (command.action === 'goal' && 'id' in command && 'goalAction' in command)
          return host.request('agent.sessions.goal', { id: command.id, action: command.goalAction })
        if (command.action === 'list') return host.request('agent.sessions.list', {})
        if (command.action === 'queue') {
          const queueCommand = command as Extract<import('@gugu/core/desktop').DesktopAgentSessionCommand, { action: 'queue' }>
          const { operationId, queueAction } = queueCommand
          const params: Record<string, unknown> = { action: queueAction }
          if ('queueId' in queueCommand) params.queue_id = queueCommand.queueId
          if ('sessionId' in queueCommand) params.session_id = queueCommand.sessionId
          if ('items' in queueCommand) params.items = queueCommand.items
          if ('removedKeys' in queueCommand) params.removed_keys = queueCommand.removedKeys
          if ('key' in queueCommand) params.key = queueCommand.key
          if ('claimToken' in queueCommand) params.claim_token = queueCommand.claimToken
          return host.request('agent.sessions.queue', params, operationId)
        }
        if (command.action === 'respond' && 'id' in command && typeof command.id === 'number'
          && 'runId' in command && typeof command.runId === 'string'
          && 'promptId' in command && typeof command.promptId === 'number') {
          const { id, runId, promptId } = command
          const recovering = 'recover' in command && command.recover === true && !('token' in command) && !('text' in command) && !('secrets' in command)
          const reply = 'secrets' in command && !('text' in command) && !('token' in command)
            ? { secrets: command.secrets }
            : !('secrets' in command) && 'token' in command && typeof command.token === 'string' && !('text' in command)
            ? { token: command.token }
            : !('secrets' in command) && 'text' in command && typeof command.text === 'string' && !('token' in command)
              ? { text: command.text } : null
          const eventId = 'operationId' in command && typeof command.operationId === 'string' ? command.operationId : undefined
          if (!recovering && (!reply || !eventId)) throw new DesktopError('invalid_request', '交互回复无效')
          const modelId = await host.request<string | null>('agent.sessions.runModel', { id, runId })
          const config = await model.resolveRunModel(modelId ?? undefined)
          const embedding = await resolveEmbedding?.()
          return host.request('agent.sessions.respond', { id, runId, promptId,
            ...(recovering ? {} : { ...reply, eventId }), model: config, ...(embedding ? { embedding } : {}) })
        }
        if (command.action === 'cancelRun' && 'id' in command && 'runId' in command)
          return host.request('agent.sessions.cancelRun', { id: command.id, runId: command.runId })
        if (command.action === 'events' && 'id' in command)
          return host.request('agent.sessions.events', {
            id: command.id, ...('runId' in command ? { runId: command.runId } : {}),
            ...('after' in command ? { after: command.after } : {}),
            ...('stateOnly' in command ? { stateOnly: command.stateOnly } : {}),
          })
        if (command.action === 'messageLocation' && 'messageId' in command)
          return host.request('agent.sessions.messageLocation', { messageId: command.messageId })
        if (command.action === 'history' && 'id' in command)
          return host.request('agent.sessions.history', { id: command.id, ...('before' in command ? { before: command.before } : {}) })
        if (command.action === 'toolDetails' && 'id' in command && 'messageId' in command && 'index' in command)
          return host.request('agent.sessions.toolDetails', { id: command.id, messageId: command.messageId, index: command.index })
        if (command.action === 'messages' && 'id' in command)
          return host.request('agent.sessions.messages', { id: command.id })
        if (command.action === 'create' && 'title' in command && 'operationId' in command && typeof command.operationId === 'string')
          return host.request('agent.sessions.create', { title: command.title }, command.operationId)
      }
      throw new DesktopError('invalid_request', '会话操作无效')
    },
  }
}

export function agentModelHandlers(model: ReturnType<typeof createDesktopAgentModelService>): IpcHandlers {
  return {
    [DESKTOP_CHANNELS.agentModel]: async command => {
      if (command && typeof command === 'object' && 'action' in command) {
        const preset = 'preset' in command ? command.preset : null
        const id = 'id' in command ? command.id : undefined
        switch (command.action) {
          case 'get': return model.get()
          case 'save': return model.save(preset)
          case 'list': return model.list()
          case 'put':
            if (id === null || typeof id === 'string') return model.put(preset, id)
            break
          case 'set_default':
            if (typeof id === 'string') return model.setDefault(id)
            break
          case 'delete':
            if (typeof id === 'string') return model.remove(id)
            break
          case 'models':
            if (id == null || typeof id === 'string') return model.models(preset, id)
            break
          case 'test':
            if (id == null || typeof id === 'string') return model.test(id, preset ?? undefined)
            break
          case 'capabilities': return model.capabilities('model' in command ? command.model : null)
          case 'probe':
            if (id == null || typeof id === 'string') return model.probeMedia(preset, 'dim' in command ? command.dim : null, id)
            break
        }
      }
      throw new DesktopError('invalid_request', '模型配置操作无效')
    },
  }
}
