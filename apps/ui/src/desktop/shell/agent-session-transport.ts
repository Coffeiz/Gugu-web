import { createAgentChatSseDecoder } from '@gugu/core/agent/chat-sse'
import type { DesktopAgentChatEvent, DesktopAgentMessage, DesktopAgentSession, DesktopBridge, DesktopReply } from '@gugu/core/desktop'
import { getLocale } from '@/i18n'
import { DesktopBridgeError } from '@desktop/bridge/bridge'

import { agentSessionPreviewPath } from '../../../../desktop/src/shared/agent-session-preview'

type DesktopWindow = Window & { guguDesktop?: DesktopBridge }

export function requestDesktopAgentSessions(command: { action: 'forgetMemory'; query: string; revision?: string }): Promise<{ count: number; revision: string }>
export function requestDesktopAgentSessions(command: Extract<import('@gugu/core/desktop').DesktopAgentSessionCommand, { action: 'goal' }>): Promise<{ text: string }>
export function requestDesktopAgentSessions(command: { action: 'readMemory' }): Promise<{ text: string }>
export function requestDesktopAgentSessions(command: { action: 'messageLocation'; messageId: number }): Promise<{ id: number; sessionId: number }>
export function requestDesktopAgentSessions(command: { action: 'history'; id: number; before?: number }): Promise<import('@gugu/core/desktop').DesktopAgentHistoryPage>
export function requestDesktopAgentSessions(command: { action: 'toolDetails'; id: number; messageId: number; index: number }): Promise<Record<string, unknown>>
export function requestDesktopAgentSessions(command: Extract<import('@gugu/core/desktop').DesktopAgentSessionCommand, { action: 'respond' }>): Promise<import('@gugu/core/desktop').DesktopAgentInteractionReply>
export function requestDesktopAgentSessions(command: { action: 'cancelRun'; id: number; runId: string }): Promise<import('@gugu/core/desktop').DesktopAgentRunCancellation>
export function requestDesktopAgentSessions(command: { action: 'events'; id: number; runId?: string; after?: number; stateOnly?: true }): Promise<import('@gugu/core/desktop').DesktopAgentEventPage>
export function requestDesktopAgentSessions(command: Extract<import('@gugu/core/desktop').DesktopAgentSessionCommand, { action: 'queue' }>): Promise<import('@gugu/core/desktop').DesktopAgentQueueSnapshot | import('@gugu/core/desktop').DesktopAgentImportedQueue[] | Record<string, unknown> | boolean | null>
export function requestDesktopAgentSessions(command: { action: 'list' }): Promise<DesktopAgentSession[]>
export function requestDesktopAgentSessions(command: Extract<Parameters<DesktopBridge['agentSessions']>[0], { action: 'messages' | 'resume' | 'send' }>): Promise<DesktopAgentMessage[]>
export function requestDesktopAgentSessions(command: { action: 'cancel'; id: number; operationId: string }): Promise<null>
export function requestDesktopAgentSessions(command: Extract<Parameters<DesktopBridge['agentSessions']>[0], { action: 'create' | 'rename' }>): Promise<DesktopAgentSession>
export function requestDesktopAgentSessions(command: Extract<Parameters<DesktopBridge['agentSessions']>[0], { action: 'delete' }>): Promise<null>
export async function requestDesktopAgentSessions(command: Parameters<DesktopBridge['agentSessions']>[0]) {
  const native = (window as DesktopWindow).guguDesktop
  if (native) {
    if (typeof native.agentSessions !== 'function')
      throw new DesktopBridgeError('desktop_update_required', '桌面应用版本过旧，请重新启动后再打开会话')
    // 聊天编辑器中的引用可能仍是 Vue 响应式对象，IPC 只接收普通数据。
    const payload = command.action === 'send' && command.references
      ? { ...command, references: command.references.map(({ type, id, label }) => ({ type, id, label })) }
      : command
    return readSessionReply(await native.agentSessions(payload))
  }
  const response = await openPreviewSession(command, 'application/json')
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
    throw new DesktopBridgeError('preview_unavailable', '本机预览服务未就绪')
  return readSessionReply(await response.json())
}

function readSessionReply<T>(reply: DesktopReply<T>): T {
  if (reply.ok === false) throw new DesktopBridgeError(reply.error.code, reply.error.message, reply.error.operationId)
  return reply.result
}

function isDesktopSessionPreview() {
  return import.meta.env.DEV && new URLSearchParams(location.search).get('desktopPreview') === '1'
}

function openPreviewSession(
  command: Parameters<DesktopBridge['agentSessions']>[0] | { action: 'watchRuns' }, accept: string, signal?: AbortSignal,
) {
  if (!isDesktopSessionPreview())
    throw new DesktopBridgeError('preview_unavailable', '无法连接桌面预览')
  return fetch(agentSessionPreviewPath, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Accept: accept },
    body: JSON.stringify({ method: 'agentSessions', args: [command] }),
  })
}

export function subscribeDesktopAgentRunChanges(listener: (sessionId?: number) => void): () => void {
  const native = (window as DesktopWindow).guguDesktop
  if (native) return native.onAgentRunChanged?.(listener) ?? (() => {})
  if (!isDesktopSessionPreview()) return () => {}

  const connection = new AbortController()
  let retry: ReturnType<typeof setTimeout> | undefined
  let delay = 1000
  async function connect() {
    try {
      const response = await openPreviewSession({ action: 'watchRuns' }, 'text/event-stream', connection.signal)
      if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel()
        return
      }
      const reader = response.body.getReader()
      const decoder = createAgentChatSseDecoder()
      try {
        while (!connection.signal.aborted) {
          const { done, value } = await reader.read()
          if (done || connection.signal.aborted) break
          for (const raw of decoder.push(value)) {
            const event = JSON.parse(raw) as { type?: string; session_id?: number }
            if (event.type === 'ready') {
              delay = 1000
              listener()
            }
            if (event.type === 'run_changed' && typeof event.session_id === 'number'
              && Number.isSafeInteger(event.session_id) && event.session_id > 0) listener(event.session_id)
          }
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    } catch {
      // 重连成功后会补读持久状态。
    } finally {
      if (!connection.signal.aborted) {
        retry = setTimeout(() => void connect(), delay)
        delay = Math.min(delay * 2, 30_000)
      }
    }
  }
  void connect()
  return () => {
    connection.abort()
    clearTimeout(retry)
  }
}

export async function streamDesktopAgentMessage(
  command: Extract<Parameters<DesktopBridge['agentSessions']>[0], { action: 'send' | 'resume' }>,
  onText: (text: string) => void,
  signal?: AbortSignal,
  onSession?: (event: Extract<DesktopAgentChatEvent, { type: 'session_id' }>) => void,
  onProjected?: (event: Extract<DesktopAgentChatEvent, { type: 'projected' }>['event']) => void,
): Promise<DesktopAgentMessage[]> {
  signal?.throwIfAborted()
  const native = (window as DesktopWindow).guguDesktop
  const streamCommand = command.action === 'send' ? { ...command, locale: command.locale ?? getLocale(), stream: true } : command
  let structuredAssistant = false
  const consume = (event: DesktopAgentChatEvent) => {
    if (event?.operationId !== command.operationId) return
    if (event.type === 'session_id') onSession?.(event)
    if (event.type === 'projected') onProjected?.(event.event)
    if (event.type === 'content' && typeof event.text === 'string' && !structuredAssistant) onText(event.text)
    if (event.type === 'projected' && event.event.type === 'display_event'
      && (event.event.item as { kind?: string } | undefined)?.kind === 'assistant') structuredAssistant = true
  }
  if (native) {
    if (!native.onAgentChatEvent)
      throw new DesktopBridgeError('desktop_update_required', '请重新启动桌面应用以接收流式回复')
    const unsubscribe = native.onAgentChatEvent(consume)
    const disconnect = () => {
      unsubscribe()
      void native.agentSessions({ action: 'disconnect', operationId: command.operationId }).catch(() => {})
    }
    signal?.addEventListener('abort', disconnect, { once: true })
    try {
      return await requestDesktopAgentSessions(streamCommand)
    } finally {
      signal?.removeEventListener('abort', disconnect)
      unsubscribe()
    }
  }
  const response = await openPreviewSession(streamCommand, 'text/event-stream', signal)
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
    throw new DesktopBridgeError('preview_unavailable', '本机预览服务未就绪')
  const reader = response.body.getReader()
  const decoder = createAgentChatSseDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      for (const raw of decoder.push(value)) {
        const event = JSON.parse(raw) as DesktopAgentChatEvent | { type: 'reply'; reply: DesktopReply<DesktopAgentMessage[]> }
        if (event.type === 'reply') return readSessionReply(event.reply)
        consume(event)
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  throw new DesktopBridgeError('closed', '模型回复连接已中断')
}
