import type { DesktopImMediaRoute } from './attachments.js'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { safeStorage } from 'electron'
import { formatImToolReceipt, createImRequestedReply, parseImReceivedMessage, type ImConnectionIdentity, type ImReceivedMessage } from '@gugu/gateway'
import { redactToolError, type RunEvent } from '@gugu/core/agent'
import { isAttentionSourceKind } from '@gugu/core/im/attention/directive'
import type { DesktopAgentEventPage, DesktopAppearancePreferences } from '@gugu/core/desktop'
import { DesktopError } from '../../../core-host.js'
import type { IpcHost } from '../../../ipc/types.js'
import { desktopImEventKey, type DesktopImEnvelope } from '../inbound/inbox.js'
import type { createDesktopAgentModelService } from '../../../agent/model.js'

type Prompt = { prompt_id: number; title?: string; body?: string; options: { id: string; label: string; token: string }[] }
interface DesktopImStream {
  project(event: RunEvent): Promise<Outcome>
  close(): Promise<void>
}
type Outcome = 'accepted' | 'rejected' | 'unknown'
type SendResult = Outcome | { outcome: Outcome; platformMessageIds?: readonly string[] }
type AcceptedReplyFact = { platformMessageIds: readonly string[]; recipientSenderId: string; sentAtMs: number; sourceAttentionKind?: string }
type Prepared = { sessionId: number; runId: string | null; eventKey: string; sealedEvent: string; clientId: string }

export function createDesktopImDispatch(host: IpcHost, encryption: Pick<typeof safeStorage, 'decryptStringAsync'>,
  model: Pick<ReturnType<typeof createDesktopAgentModelService>, 'resolveRunModelSelection'>,
  readPreferences?: () => Promise<DesktopAppearancePreferences>,
  report?: (code: string, error: unknown) => void, registerMedia?: (route: DesktopImMediaRoute) => () => void) {
  return async (options: {
    connection: ImConnectionIdentity; connectionId: string; signal: AbortSignal
    createStream?(target: { eventKey: string; runId: string; sessionId: number; messageId: string; referenceMessageId?: string; preferences?: DesktopAppearancePreferences }): Promise<DesktopImStream | undefined>
    startTyping?(replyContext: string): () => Promise<void>
    sendPrompt?(prompt: Prompt, recipient: string): Promise<string | null>
    media?: DesktopImMediaRoute['media']
    authorize(): Promise<boolean>
    send(reply: NonNullable<ReturnType<typeof createImRequestedReply>>, replyContext?: string): Promise<SendResult>
  } & ({ userId: string; group?: never } | {
    group: { id: string; ownerPlatformUserId: string; authorizeMessage(event: ImReceivedMessage): Promise<boolean>; authorizeFile(event: ImReceivedMessage): Promise<boolean> }; userId?: never
  })) => {
    const { connection, connectionId, signal } = options
    const mediaRoute = options.userId
      ? { connection, connectionId, signal, userId: options.userId }
      : options.group ? { connection, connectionId, signal, group: options.group } : undefined
    const unregister = options.media && mediaRoute && registerMedia?.({
      ...mediaRoute, media: options.media, authorize: options.authorize,
    })
    const scope = { platform: connection.platform, connectionId }
    let projection: { runId: string; sessionId: number; cursor: number; messages: Map<string, string>; pendingRound?: { sequence: number; text: string }; finalText?: string; prompt?: Prompt; stream?: DesktopImStream; streamOutcome?: Outcome; streamFinal?: boolean } | undefined
    let change = 0
    let pendingWake: AbortController | undefined
    const unsubscribe = host.onAgentRunChanged?.((sessionId, runId) => {
      if (projection?.sessionId !== sessionId || projection.runId !== runId) return
      change++
      pendingWake?.abort()
    })
    let reportedMissingModel = false
    let typing: { runId: string; stop: () => Promise<void> } | undefined
    async function stopTyping() {
      const previous = typing
      typing = undefined
      await previous?.stop()
    }
    try {
      while (!signal.aborted) {
        const observed = change
        let keepTyping = false
        let retryRequired = false
        try {
          if (!await options.authorize()) return
          const item = await host.request<Prepared | null>('im.inbox.prepare', options.group ? { ...scope, chatType: 'group', ownerPlatformUserId: options.group.ownerPlatformUserId } : scope)
          if (item) {
            const { result } = await encryption.decryptStringAsync(Buffer.from(item.sealedEvent, 'base64'))
            let envelope: DesktopImEnvelope | undefined
            try {
              const candidate = JSON.parse(result) as { event: unknown; replyContext?: unknown; attachments?: unknown; sourceAttentionKind?: unknown; pendingAskResume?: unknown }
              const event = parseImReceivedMessage(connection, candidate.event)
              const replyContext = candidate.replyContext
              const attachments = candidate.attachments
              if (desktopImEventKey(event) === item.eventKey
                && (attachments === undefined || Array.isArray(attachments) && attachments.length <= 32
                  && attachments.every(id => typeof id === 'string' && /^[a-f0-9]{32}$/u.test(id)))
                && (replyContext === undefined || (connection.platform === 'wechat' || connection.platform === 'feishu') && typeof replyContext === 'string')
                && (candidate.sourceAttentionKind === undefined || isAttentionSourceKind(candidate.sourceAttentionKind))
                && (candidate.pendingAskResume === undefined || candidate.pendingAskResume === true && options.group !== undefined))
                envelope = { event, replyContext, attachments,
                  ...(typeof candidate.sourceAttentionKind === 'string' ? { sourceAttentionKind: candidate.sourceAttentionKind } : {}),
                  ...(candidate.pendingAskResume === true ? { pendingAskResume: true } : {}) }
            } catch { /* 解密成功后的无效数据可以结案。 */ }
            const event = envelope?.event
            const matches = event && (options.group
              ? event.scope.chatType === 'group' && event.scope.chatId === options.group.id
              : event.scope.chatType === 'c2c' && event.scope.platformUserId === options.userId)
            if (!event || !matches || (!event.text.trim() && !event.quotedText && !envelope?.attachments?.length)) {
              if (!await options.authorize()) return
              if (!item.runId && await host.request('im.inbox.reject', { ...scope, eventKey: item.eventKey })) continue
              throw new Error('本机 IM 收件与连接不匹配')
            }
            const replyContext = envelope?.replyContext
            if (!await options.authorize()) return
            if (!item.runId && options.group && !await options.group.authorizeMessage(event)) {
              if (await host.request('im.inbox.reject', { ...scope, eventKey: item.eventKey })) continue
              return
            }
            if (!item.runId) {
              const selection = await model.resolveRunModelSelection()
              reportedMissingModel = false
              if (!await options.authorize()) return
              if (options.group && !await options.group.authorizeMessage(event)) continue
              await host.request('agent.sessions.startRun', {
                id: item.sessionId, text: event.quotedText ? `引用消息：${JSON.stringify(event.quotedText)}\n\n${event.text}` : event.text, clientId: item.clientId, model: selection.config, modelId: selection.id, interactive: !options.group && Boolean(options.sendPrompt),
                ...(options.group ? { groupSender: { id: event.scope.platformUserId, name: event.platformUserName } } : {}),
                ...(envelope?.pendingAskResume ? { resumePassiveMessage: true } : {}),
                ...(envelope?.attachments ? { attachments: envelope.attachments } : {}),
              })
              continue
            }
            const clientId = item.clientId
            const target = { ...scope, eventKey: item.eventKey, runId: item.runId }
            const update = (action: 'begin' | Outcome, noticeKey?: string, replyFact?: AcceptedReplyFact) =>
              host.request<boolean>('im.inbox.delivery', { ...target, action, ...(noticeKey ? { noticeKey } : {}), ...(replyFact ? { replyFact } : {}) })
            const preferences = options.group ? undefined : await readPreferences?.()
            const makeReply = (text: string, deliveryId: string) =>
              createImRequestedReply(event.scope, { ownerId: connection.ownerId, deliveryId, text }, event.platformMessageId)
            async function sendReply(reply: NonNullable<ReturnType<typeof makeReply>>, trackAcceptedFact = false): Promise<{ outcome: Outcome; replyFact?: AcceptedReplyFact }> {
              if (!await options.authorize() || options.group && !await options.group.authorizeMessage(event!)) return { outcome: 'rejected' }
              try {
                const sent = await options.send(reply, replyContext)
                const outcome = typeof sent === 'string' ? sent : sent.outcome
                const ids = typeof sent === 'string' ? [] : [...new Set(sent.platformMessageIds ?? [])]
                const recipientSenderId = options.group ? event!.scope.platformUserId : null
                return { outcome, ...(trackAcceptedFact && outcome === 'accepted' && ids.length && recipientSenderId
                  ? { replyFact: { platformMessageIds: ids, recipientSenderId, sentAtMs: Date.now(),
                    ...(envelope?.sourceAttentionKind ? { sourceAttentionKind: envelope.sourceAttentionKind } : {}) } } : {}) }
              } catch { return { outcome: 'unknown' } }
            }
            async function sendNotice(key: string, text: string) {
              const noticeKey = createHash('sha256').update(JSON.stringify([clientId, key])).digest('hex')
              const reply = makeReply(text, noticeKey)
              if (!reply || !await options.authorize()) return
              if (!await update('begin', noticeKey)) return
              await update((await sendReply(reply)).outcome, noticeKey)
            }
            if (projection?.runId !== item.runId || projection.sessionId !== item.sessionId) {
              await projection?.stream?.close()
              const stream = options.group ? undefined : await options.createStream?.({ eventKey: item.eventKey, runId: item.runId, sessionId: item.sessionId,
                messageId: event.eventId, referenceMessageId: event.platformMessageId, preferences })
              projection = { runId: item.runId, sessionId: item.sessionId, cursor: 0, messages: new Map(), stream }
            }
            const current = projection
            let status: string
            do {
              const page = await host.request<DesktopAgentEventPage>('agent.sessions.events', { id: item.sessionId, runId: item.runId, after: current.cursor, ...(preferences || current.stream || options.group ? { imDelivery: true } : {}), ...(current.stream ? { imStream: true } : {}) })
              for (const entry of page.events) {
                if (entry.type === 'im_stream' && current.stream && current.streamOutcome !== 'unknown' && current.streamOutcome !== 'rejected') {
                  const runEvent = entry.runEvent as RunEvent
                  current.streamOutcome = await current.stream.project(runEvent)
                  if (runEvent.type === 'final') current.streamFinal = true
                }
                if (entry.type === 'im_round_end' && typeof entry.sequence === 'number' && typeof entry.text === 'string')
                  current.pendingRound = { sequence: entry.sequence, text: entry.text }
                if ((entry.type === 'round_start' || entry.type === 'im_round_continues') && current.pendingRound) {
                  const pending = current.pendingRound
                  if (!current.stream && preferences?.showIntermediateReplies) await sendNotice(`round:${pending.sequence}`, pending.text)
                  current.pendingRound = undefined
                }
                if (entry.type === 'im_final_text' && typeof entry.text === 'string') current.finalText = entry.text
                if (entry.type === 'interaction_required' && entry.task_paused === true && entry.resolved !== true
                  && Array.isArray(entry.secret_fields) && !entry.secret_fields.length
                  && typeof entry.prompt_id === 'number' && Array.isArray(entry.options) && entry.options.length)
                  current.prompt = entry as unknown as Prompt
                if (entry.type !== 'display_event' || !entry.item || typeof entry.item !== 'object') continue
                const message = entry.item as { kind?: string; eventId?: string; text?: string
                  toolName?: string; toolLabelOverride?: string; toolStatus?: string; toolDurationMs?: number }
                if (message.kind === 'assistant' && typeof message.eventId === 'string' && typeof message.text === 'string')
                  current.messages.set(message.eventId, message.text)
                const toolMode = preferences?.imToolDisplayMode
                if (toolMode && toolMode !== 'off' && message.kind === 'tool' && typeof message.eventId === 'string'
                  && typeof message.toolName === 'string' && /^[\w.:-]{1,120}$/u.test(message.toolName)
                  && (message.toolStatus === 'success' || message.toolStatus === 'error')
                  && (toolMode === 'all' || (message.toolDurationMs ?? 0) >= 5000))
                  await sendNotice(`tool:${message.eventId}`, formatImToolReceipt({
                    name: message.toolName, label: message.toolLabelOverride, status: message.toolStatus,
                  }, redactToolError))
              }
              current.cursor = page.cursor
              status = page.status
              if (!page.hasMore) break
            } while (!signal.aborted)
            if (!await options.authorize()) return
            keepTyping = status === 'preparing' || status === 'running'
            if (!keepTyping || typing?.runId !== item.runId) await stopTyping()
            if (keepTyping && !typing && replyContext && options.startTyping)
              typing = { runId: item.runId, stop: options.startTyping(replyContext) }
            const prompt = current.prompt
            if (status === 'waiting' && prompt && options.sendPrompt && options.userId) {
              const request = { ...target, promptId: prompt.prompt_id }
              if (await host.request<boolean>('im.inbox.prompt', { ...request, action: 'begin' })) {
                let messageId: string | null = null
                try { if (await options.authorize()) messageId = await options.sendPrompt(prompt, options.userId) }
                finally { await host.request('im.inbox.prompt', { ...request, action: 'settle', messageId }) }
              }
              current.prompt = undefined
            }
            if (['completed', 'failed', 'startup_failed', 'cancelled', 'unknown'].includes(status)) {
              const messages = [...current.messages.values()].filter(message => message.trim())
              const text = preferences || options.group ? current.finalText ?? messages.at(-1) ?? '' : messages.join('\n\n')
              if (!await options.authorize()) return
              if (current.stream) await current.stream.close()
              if (!await update('begin')) await update('unknown')
              else {
                if (current.stream) await update(current.streamOutcome === 'accepted' && !current.streamFinal ? 'unknown' : current.streamOutcome ?? 'unknown')
                else {
                  const reply = makeReply(text, item.clientId)
                  if (reply && status === 'completed') {
                    const sent = await sendReply(reply, Boolean(options.group))
                    await update(sent.outcome, undefined, sent.replyFact)
                  } else await update('rejected')
                }
              }
              projection = undefined
              continue
            }
          }
        } catch (error) {
          retryRequired = true
          if (!signal.aborted) {
            if (error instanceof DesktopError && error.code === 'model_unavailable') {
              if (!reportedMissingModel) report?.('im_model_unavailable', error)
              reportedMissingModel = true
            } else report?.('dispatch_unavailable', error)
          }
          // 收件已持久化，下次迭代从原状态恢复。
        } finally {
          if (!keepTyping || signal.aborted) await stopTyping()
        }
        if (!retryRequired && change !== observed) continue
        const wake = new AbortController()
        if (!retryRequired) pendingWake = wake
        try {
          // 通知只唤醒读取。定时补读覆盖漏通知和未关联运行的入站消息。
          await delay(1_000, undefined, { signal: AbortSignal.any([signal, wake.signal]) }).catch(() => {})
        } finally {
          pendingWake = undefined
        }
      }
    } finally {
      if (unregister) unregister()
      unsubscribe?.()
      await projection?.stream?.close()
      await stopTyping()
    }
  }
}
