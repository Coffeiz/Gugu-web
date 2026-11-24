import { DesktopBridgeError } from '@desktop/bridge/bridge'
import { encodeAgentChatSse } from '@gugu/core/agent/chat-sse'
import type { DesktopAgentHistoryPage } from '@gugu/core/desktop'
import {
  requestDesktopAgentSessions,
  streamDesktopAgentMessage,
} from './agent-session-transport'

const encoder = new TextEncoder()

function frame(event: Record<string, unknown>) {
  return encoder.encode(encodeAgentChatSse(event))
}

export async function listDesktopChatSessions() {
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestDesktopAgentSessions({ action: 'list' })
    } catch (error) {
      if (attempt >= 5 || !(error instanceof DesktopBridgeError) || error.code !== 'closed') throw error
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
}

export async function getDesktopChatHistory(id: number, before?: number) {
  const page = await requestDesktopAgentSessions({ action: 'history', id, ...(before === undefined ? {} : { before }) })
  if (before !== undefined) return { ...desktopHistoryToWebShape(page), pendingQueue: [] }
  const queue = await readDesktopChatQueue(`session-${id}`)
  return { ...desktopHistoryToWebShape(page, page.active), pendingQueue: queue.items }
}

/** 搜索跳转按本地历史分页定位目标消息，不向 Web 会话接口回退。 */
export async function getDesktopChatHistoryThroughMessage(id: number, messageId: number) {
  let before: number | undefined
  const pages: DesktopAgentHistoryPage[] = []
  while (true) {
    const page = await requestDesktopAgentSessions({ action: 'history', id, ...(before === undefined ? {} : { before }) })
    pages.push(page)
    if (page.messages.some(message => message.id === messageId)) {
      const latest = pages[0]!
      return desktopHistoryToWebShape({
        ...latest,
        messages: pages.reverse().flatMap(result => result.messages),
        pagination: page.pagination,
      }, latest.active)
    }
    const cursor = page.pagination.oldestId
    if (!page.pagination.hasMore || cursor === null) break
    if (before !== undefined && cursor >= before) throw new Error('历史游标未前进')
    before = cursor
  }
  throw new Error('目标消息不在本地会话历史中')
}

export function desktopHistoryToWebShape(page: DesktopAgentHistoryPage, active = false) {
  return {
    messages: page.messages
      .filter(message => message.role !== 'assistant' || (
        !message.assistantTimeline?.some(item => item.text)
        && (message.text.trim() || message.files?.length || !message.toolTimeline?.length)
      ))
      .map(message => ({
        id: message.id,
        role: message.role,
        content: message.text,
        quotedText: message.quotedText,
        createdAt: message.createdAt,
        clientMessageId: message.clientMessageId,
        runId: message.runId,
        runOutcome: message.runOutcome,
        timelineOrder: message.id,
        files: message.files?.map(file => ({ ...file, size_bytes: file.size_bytes ?? file.size })),
        references: message.references,
        platformUserId: message.platformUserId,
        platformUserName: message.platformUserName,
      })),
    timelineEvents: page.messages.flatMap(message => [
      ...(message.toolTimeline ?? []),
      ...(message.assistantTimeline ?? []),
    ]).sort((left, right) => {
      if (left.timelineOrder != null && right.timelineOrder != null)
        return Number(left.timelineOrder) - Number(right.timelineOrder)
      return Date.parse(left.createdAt) - Date.parse(right.createdAt)
        || (left.runId === right.runId ? left.sequence - right.sequence : 0)
    }),
    interactions: page.messages.flatMap(message => message.interactions ?? []),
    session: page.session,
    pagination: page.pagination,
    executionState: page.executionState,
    active,
  }
}

export async function createDesktopChatSession(title: string, greeting?: string) {
  return requestDesktopAgentSessions({ action: 'create', title, operationId: crypto.randomUUID(), ...(greeting ? { greeting } : {}) })
}

export async function renameDesktopChatSession(id: number, title: string) {
  return requestDesktopAgentSessions({ action: 'rename', id, title, operationId: crypto.randomUUID() })
}

export async function deleteDesktopChatSession(id: number) {
  return requestDesktopAgentSessions({ action: 'delete', id, operationId: crypto.randomUUID() })
}

export async function getDesktopRunState(id: number) {
  return requestDesktopAgentSessions({ action: 'events', id, stateOnly: true })
}

export async function cancelDesktopChatSession(id: number) {
  const state = await getDesktopRunState(id)
  if (!state.runId) return { outcome: 'already_completed' as const }
  const result = await requestDesktopAgentSessions({ action: 'cancelRun', id, runId: state.runId })
  return { outcome: result.outcome === 'requested' ? 'interrupted' as const : result.outcome }
}

export async function readDesktopChatQueue(queueId: string) {
  const result = await requestDesktopAgentSessions({ action: 'queue', queueAction: 'read', queueId }) as
    { sessionId: number | null; items: unknown[]; projected: true } | null
  return result ?? { sessionId: null, items: [] }
}

export async function readDesktopImportedChatQueues() {
  const queues = await requestDesktopAgentSessions({ action: 'queue', queueAction: 'imports' }) as
    Array<{ queueId: string; items: unknown[]; projected: true }>
  return { queues }
}

export async function replaceDesktopChatQueue(queueId: string, items: Record<string, unknown>[]) {
  return requestDesktopAgentSessions({ action: 'queue', queueAction: 'replace', operationId: crypto.randomUUID(), queueId, items })
}

export async function patchDesktopChatQueue(queueId: string, sessionId: number, items: Record<string, unknown>[], removedKeys: number[] = []) {
  return requestDesktopAgentSessions({ action: 'queue', queueAction: 'patch', operationId: crypto.randomUUID(), queueId, sessionId, items, removedKeys })
}

export async function claimDesktopChatQueueItem(queueId: string, sessionId: number, key: number) {
  const result = await requestDesktopAgentSessions({ action: 'queue', queueAction: 'claim', queueId, sessionId, key }) as
    { claimToken: string | null; reason?: 'session_active' }
  return { claim_token: result.claimToken, reason: result.reason }
}

export async function releaseDesktopChatQueueItem(queueId: string, sessionId: number, key: number, claimToken: string) {
  return requestDesktopAgentSessions({ action: 'queue', queueAction: 'release', queueId, sessionId, key, claimToken })
}

export function createDesktopChatEventStream(
  command: Extract<Parameters<typeof streamDesktopAgentMessage>[0], { action: 'send' | 'resume' }>,
  signal: AbortSignal,
) {
  const delivery = new AbortController()
  const connection = AbortSignal.any([signal, delivery.signal])
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      let waitingForInteraction = false
      let confirmedRunId = command.action === 'resume' ? command.runId : undefined
      let sessionConfirmed = false
      let errorSent = false
      let terminal: Record<string, unknown> | undefined
      let terminalForwarded = false
      const push = (event: Record<string, unknown>) => {
        if (!closed && !connection.aborted) controller.enqueue(frame(event))
      }
      const close = () => {
        if (closed) return
        closed = true
        controller.close()
      }
      const onAbort = () => {
        if (!delivery.signal.aborted) close()
        else closed = true
      }
      if (connection.aborted) { close(); return }
      connection.addEventListener('abort', onAbort, { once: true })
      void (async () => {
        try {
          const messages = await streamDesktopAgentMessage(
            command,
            text => push({ type: 'content', text }),
            connection,
            event => {
              sessionConfirmed = true
              confirmedRunId = event.run_id ?? confirmedRunId
              push({ type: 'session_id', session_id: event.session_id,
                ...(event.user_message_id ? { user_message_id: event.user_message_id } : {}),
                ...(event.run_id ? { run_id: event.run_id } : {}),
                ...(event.client_message_id ? { client_message_id: event.client_message_id } : {}),
              })
            },
            event => {
              if (terminal) return
              if (event.type === 'interaction_required' && event.resolved !== true) waitingForInteraction = true
              if (event.type === 'interaction_resolved') waitingForInteraction = false
              if (event.type === 'error') errorSent = true
              if (event.type === 'done') {
                terminal = event
                // 缺少发送确认时，先通过持久消息核实接收，再结束共享聊天流。
                if (command.action === 'send' && !sessionConfirmed) return
                terminalForwarded = true
              }
              push(event)
            },
          )
          if (closed || terminalForwarded) return
          const clientMessageId = command.action === 'send' ? command.clientMessageId : undefined
          const persistedUser = clientMessageId ? messages.find(message => message.role === 'user'
            && message.clientMessageId === clientMessageId) : undefined
          const runId = confirmedRunId ?? persistedUser?.runId
          confirmedRunId = runId
          if (!sessionConfirmed && (persistedUser || command.action === 'resume')) push({ type: 'session_id', session_id: command.id,
            ...(persistedUser ? { user_message_id: persistedUser.id, client_message_id: persistedUser.clientMessageId } : {}),
            ...(runId ? { run_id: runId } : {}) })
          if (terminal) return
          const outcome = runId ? messages.findLast(message => message.runId === runId && message.runOutcome)?.runOutcome : undefined
          if (!waitingForInteraction && !outcome && !errorSent)
            throw new DesktopBridgeError('closed', '聊天事件连接已中断，可重新打开会话查看')
          terminal = {
            type: 'done',
            ...(runId ? { run_id: runId } : {}),
            ...(outcome ? { cancelled: outcome.status === 'interrupted', run_outcome: outcome } : {}),
            ...(waitingForInteraction && !outcome ? { waiting_for_interaction: true } : {}),
          }
        } catch (error) {
          if (!errorSent && !terminal) {
            const interrupted = Boolean(confirmedRunId) && error instanceof DesktopBridgeError
              && ['closed', 'transport_failed'].includes(error.code)
            push({ type: 'error', message: error instanceof DesktopBridgeError ? error.message : '生成失败，请稍后重试',
              ...(interrupted ? { delivery_interrupted: true } : {}) })
          }
        } finally {
          // 发送已获接收回执时，传输中断不能替运行宣告终态。
          if (!terminalForwarded && terminal) push(terminal)
          else if (!terminal && !confirmedRunId && !sessionConfirmed) push({ type: 'done' })
          connection.removeEventListener('abort', onAbort)
          close()
        }
      })()
    },
    cancel() { delivery.abort() },
  })
}


export function readDesktopChatToolDetails(id: number, { messageId, index }: { messageId: number; index: number }) {
  return requestDesktopAgentSessions({ action: 'toolDetails', id, messageId, index })
}
