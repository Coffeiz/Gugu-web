import { resolveQqNoticeTarget, type QqNoticeKind } from '@gugu/gateway/qq'
import { runDesktopWorkspaceExtra, type DesktopWorkspaceCommands } from '../../../agent/workspace-command.js'
import type { DesktopImMediaRoute } from './attachments.js'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { safeStorage } from 'electron'
import { formatImToolReceipt, replyToImMemoryCommand, readImAddressedCommand, createImRequestedReply, parseImReceivedMessage, type ImConnectionIdentity, type ImInboundConsumption, type ImReceivedMessage } from '@gugu/gateway'
import { redactToolError, type RunEvent } from '@gugu/core/agent'
import { immediateImCommandReply, normalizeImWorkspaceArgument, runImAutomaticModeCommand, runImForgetCommand } from '@gugu/core/im/shortcut'
import { agentCommandMenu, desktopWorkspaceReply, parseAgentGoalArgument, parseDesktopWorkspaceCommand } from '@gugu/core/agent/commands/menu'
import { formatImCompactionNotice } from '@gugu/core/im/run-delivery'
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

export async function stopDesktopImRun(host: IpcHost, event: ImReceivedMessage, connectionId: string, ownerPlatformUserId?: string) {
  const hash = createHash('sha256').update(JSON.stringify([connectionId, desktopImEventKey(event), 'stop'])).digest('hex')
  const operation = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  const { outcome } = await host.request<{ outcome: string }>('im.inbox.cancelRun', {
    platform: event.scope.platform, connectionId, chatType: event.scope.chatType, platformUserId: event.scope.platformUserId,
    ...(ownerPlatformUserId === undefined ? {} : { ownerPlatformUserId }),
  }, operation)
  return outcome === 'requested' ? '🛑 已停止当前任务'
    : outcome === 'not_owner' ? '只能停止自己发起的任务。'
      : outcome === 'already_completed' ? '这个任务已经结束啦～' : '当前没有正在运行的任务。'
}

export async function readDesktopImRunStatus(host: IpcHost, event: ImReceivedMessage, connectionId: string, ownerPlatformUserId?: string) {
  const { status } = await host.request<{ status: string }>('im.inbox.status', {
    platform: event.scope.platform, connectionId, chatType: event.scope.chatType, platformUserId: event.scope.platformUserId,
    ...(ownerPlatformUserId === undefined ? {} : { ownerPlatformUserId }),
  })
  if (status === 'compacting') return '正在整理上下文。'
  if (status === 'waiting_agent') return '正在等待子 Agent 的消息。'
  return status === 'waiting' ? '正在等待你的确认。'
    : status === 'preparing' || status === 'running' ? '当前任务仍在运行。' : '当前没有正在运行的任务。'
}

export function createDesktopImDispatch(host: IpcHost, encryption: Pick<typeof safeStorage, 'decryptStringAsync'>,
  model: Pick<ReturnType<typeof createDesktopAgentModelService>, 'resolveRunModelSelection'>,
  readPreferences?: () => Promise<DesktopAppearancePreferences>,
  report?: (code: string, error: unknown, method?: string) => void, registerMedia?: (route: DesktopImMediaRoute) => () => void,
  workspaceCommands?: DesktopWorkspaceCommands) {
  return async (options: {
    connection: ImConnectionIdentity; connectionId: string; signal: AbortSignal
    createStream?(target: { eventKey: string; runId: string; sessionId: number; messageId: string; referenceMessageId?: string; preferences?: DesktopAppearancePreferences }): Promise<DesktopImStream | undefined>
    startTyping?(replyContext: string): () => Promise<void>
    sendOwnerPrivate?(text: string): Promise<Outcome>
    sendPrompt?(prompt: Prompt, recipient: string): Promise<string | null>
    media?: DesktopImMediaRoute['media']
    authorize(): Promise<boolean>
    sendActiveNotice?(reply: NonNullable<ReturnType<typeof createImRequestedReply>>): Promise<Outcome>
    send(reply: NonNullable<ReturnType<typeof createImRequestedReply>>, replyContext?: string, senderName?: string): Promise<SendResult>
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
    let projection: { runId: string; sessionId: number; cursor: number; messages: Map<string, string>; sentRound?: { text: string; outcome: Outcome }; finalText?: string; prompt?: Prompt; stream?: DesktopImStream; streamOutcome?: Outcome; streamFinal?: boolean } | undefined
    let change = 0
    let pendingWake: AbortController | undefined
    const unsubscribe = host.onAgentRunChanged?.((sessionId, runId) => {
      if (projection?.sessionId !== sessionId || projection.runId !== runId) return
      change++
      pendingWake?.abort()
    })
    let lastFailure: string | undefined
    let retryDelay = 1_000
    let rpcMethod: string | undefined
    const callRpc: IpcHost['request'] = async (method, params) => {
      try {
        return await host.request(method, params)
      } catch (error) {
        rpcMethod = method
        throw error
      }
    }
    const inbox: ImInboundConsumption<[], Prepared | null,
      [{ eventKey: string } | { eventKey: string; runId: string; action: Outcome; replyFact?: AcceptedReplyFact }], boolean> = {
      claimInbound: () => callRpc('im.inbox.prepare', options.group
        ? { ...scope, chatType: 'group', ownerPlatformUserId: options.group.ownerPlatformUserId } : scope),
      settleInbound: result => 'runId' in result
        ? callRpc('im.inbox.delivery', { ...scope, ...result })
        : callRpc('im.inbox.reject', { ...scope, ...result }),
    }
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
          rpcMethod = undefined
          if (!await options.authorize()) return
          const item = await inbox.claimInbound()
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
              if (!item.runId && await inbox.settleInbound({ eventKey: item.eventKey })) continue
              throw new Error('本机 IM 收件与连接不匹配')
            }
            const replyContext = envelope?.replyContext
            if (!await options.authorize()) return
            if (!item.runId && options.group && !await options.group.authorizeMessage(event)) {
              if (await inbox.settleInbound({ eventKey: item.eventKey })) continue
              return
            }
            if (!item.runId) {
              const { semantic, command, unaddressed } = readImAddressedCommand(event)
              const available = agentCommandMenu().map(item => item.command.slice(1))
              let commandReply = command ? immediateImCommandReply(semantic, available) : null
              if (unaddressed?.name === 'goal') {
                if (!await inbox.settleInbound({ eventKey: item.eventKey })) return
                continue
              }
              const goal = command?.name === 'goal' ? parseAgentGoalArgument(command.argument) : null
              const owner = !options.group || event.scope.platformUserId === options.group.ownerPlatformUserId
              const startGoal = goal === 'create' && owner && !commandReply
              if (command && !startGoal) {
                if (!await inbox.settleInbound({ eventKey: item.eventKey })) return
                if (!commandReply && command.name === 'workspace') {
                  const argument = normalizeImWorkspaceArgument(command.argument)
                  const workspace = parseDesktopWorkspaceCommand(argument)
                  if (options.group) commandReply = '请在私聊中查看或绑定工作区。'
                  else commandReply = await runDesktopWorkspaceExtra(argument, workspaceCommands, options.authorize,
                    async () => desktopWorkspaceReply('show', await callRpc('agent.sessions.workspace', {
                      id: item.sessionId, action: 'show', imPlatform: connection.platform, imConnectionId: connectionId,
                    })))
                  if (!commandReply) {
                    if (!workspace) commandReply = '请使用 /workspace list、show、bind <序号或名称> 或 unlink。'
                    else try {
                      const write = workspace.action === 'bind' || workspace.action === 'unlink'
                      const result = await callRpc(write ? 'agent.sessions.setWorkspace' : 'agent.sessions.workspace', {
                        id: item.sessionId, action: workspace.action, imPlatform: connection.platform, imConnectionId: connectionId,
                        ...(workspace.directoryId ? { directoryId: workspace.directoryId } : {}),
                      })
                      commandReply = desktopWorkspaceReply(workspace.action, result)
                    } catch (error) { commandReply = error instanceof DesktopError ? error.message : '工作区命令暂时无法执行。' }
                  }
                }
                if (!commandReply && command.name === 'goal') {
                  if (!owner) commandReply = '只有绑定 Bot 的用户可以管理目标任务。'
                  else if (!goal || goal === 'create') commandReply = '用法：/goal <目标>、/goal status、/goal pause、/goal resume、/goal cancel。'
                  else commandReply = (await callRpc<{ text: string }>('agent.sessions.goal', {
                    id: item.sessionId, action: goal, imPlatform: connection.platform, imConnectionId: connectionId,
                    ...(options.group ? { imGroupSenderId: event.scope.platformUserId } : {}),
                  })).text
                }
                if (!commandReply && command.name === 'new') {
                  if (options.group && event.scope.platformUserId !== options.group.ownerPlatformUserId)
                    commandReply = '只有绑定 Bot 的用户可以开启新对话。'
                  else {
                    const result = await callRpc<{ reset: boolean }>('agent.sessions.resetImContext', {
                      id: item.sessionId, imPlatform: connection.platform, imConnectionId: connectionId,
                      ...(options.group ? { imGroupSenderId: event.scope.platformUserId } : {}),
                    })
                    commandReply = result.reset ? '已开启新对话，旧的对话上下文已清空。' : '请先等待当前任务结束或停止任务。'
                  }
                }
                if (!commandReply && command.name === 'auto') {
                  commandReply = await runImAutomaticModeCommand(command.argument, {
                    owner: !options.group || event.scope.platformUserId === options.group.ownerPlatformUserId,
                    enabled: true,
                    async read() {
                      return (await callRpc<DesktopAppearancePreferences>('preferences.desktop.get')).automaticModeEnabled === true
                    },
                    async write(enabled) {
                      const saved = await host.request<DesktopAppearancePreferences>('preferences.desktop.update',
                        { patch: { automaticModeEnabled: enabled } })
                      return saved.automaticModeEnabled === true
                    },
                  })
                }
                if (!commandReply && command.name === 'forget') {
                  commandReply = await runImForgetCommand(command.argument,
                    !options.group || event.scope.platformUserId === options.group.ownerPlatformUserId, async query => {
                      const preview = await callRpc<{ count: number; revision: string }>('agent.memory.forget', { query })
                      if (!preview.count) return 0
                      if (!await options.authorize()) return 0
                      return (await callRpc<{ count: number }>('agent.memory.forget', { query, revision: preview.revision })).count
                    })
                }
                if (!commandReply && command.name === 'memory') {
                  const sendOwnerPrivate = options.sendOwnerPrivate
                  commandReply = await replyToImMemoryCommand({
                    chatType: event.scope.chatType, signal,
                    async authorizeOwner() {
                      return owner && await options.authorize()
                        && (!options.group || await options.group.authorizeMessage(event!))
                    },
                    readMemory: async () => (await callRpc<{ text: string }>('agent.memory.read')).text,
                    sendOwnerPrivate: sendOwnerPrivate
                      ? async text => await sendOwnerPrivate(text) === 'accepted'
                      : undefined,
                  })
                }
                if (!commandReply && command.name === 'compact') {
                  if (options.group && event.scope.platformUserId !== options.group.ownerPlatformUserId)
                    commandReply = '只有绑定 Bot 的用户可以整理会话上下文。'
                  else try {
                    const { config } = await model.resolveRunModelSelection()
                    const { operation } = await callRpc<{ operation: string }>('agent.sessions.compact', {
                      id: item.sessionId, text: semantic, model: config, clientId: item.clientId,
                      imPlatform: connection.platform, imConnectionId: connectionId,
                      ...(options.group ? { imGroupSenderId: event.scope.platformUserId } : {}),
                    })
                    for (;;) {
                      signal.throwIfAborted()
                      const page = await callRpc<DesktopAgentEventPage>('agent.sessions.events', { id: item.sessionId, runId: operation })
                      if (page.status !== 'running') {
                        const reply = page.events.find(event => event.type === 'content' || event.type === 'error')
                        commandReply = typeof reply?.text === 'string' ? reply.text : '这次整理没有完成，请稍后重试。'
                        break
                      }
                      await delay(250, undefined, { signal })
                    }
                  } catch {
                    signal.throwIfAborted()
                    commandReply = '这次整理没有完成，请稍后重试。'
                  }
                }
                if (!commandReply && command.name === 'status') {
                  try {
                    commandReply = await readDesktopImRunStatus(host, event, connectionId, options.group?.ownerPlatformUserId)
                  } catch { commandReply = '当前无法读取任务状态，请稍后重试。' }
                }
                if (!commandReply && command.name === 'stop')
                  commandReply = await stopDesktopImRun(host, event, connectionId, options.group?.ownerPlatformUserId)
                if (!commandReply) continue
                const reply = createImRequestedReply(event.scope, { ownerId: connection.ownerId,
                  deliveryId: item.clientId, text: commandReply }, connection.platform === 'qq' ? event.eventId : event.platformMessageId)
                if (reply && await options.authorize()) {
                  try { await options.send(reply, replyContext) }
                  catch (error) { report?.('im_command_reply_failed', error) }
                }
                continue
              }
              const selection = await model.resolveRunModelSelection()
              if (!await options.authorize()) return
              if (options.group && !await options.group.authorizeMessage(event)) continue
              await callRpc('agent.sessions.startRun', {
                id: item.sessionId, text: startGoal ? semantic : event.text, ...(event.quotedText ? { quotedText: event.quotedText } : {}), clientId: item.clientId, model: selection.config, modelId: selection.id, interactive: !options.group && Boolean(options.sendPrompt),
                ...(options.group ? { groupSender: { id: event.scope.platformUserId, name: event.platformUserName,
                  botId: event.platformBotUserId, otherBotNames: event.otherBotNames,
                  platformSentMs: event.platformSentMs, eventReceivedMs: event.eventReceivedMs } } : {}),
                ...(envelope?.pendingAskResume ? { resumePassiveMessage: true } : {}),
                ...(envelope?.attachments ? { attachments: envelope.attachments } : {}),
              })
              continue
            }
            const clientId = item.clientId
            const target = { ...scope, eventKey: item.eventKey, runId: item.runId }
            const update = (action: 'begin' | Outcome, noticeKey?: string, replyFact?: AcceptedReplyFact) =>
              action === 'begin' || noticeKey
                ? callRpc<boolean>('im.inbox.delivery', { ...target, action, ...(noticeKey ? { noticeKey } : {}) })
                : inbox.settleInbound({ eventKey: target.eventKey, runId: target.runId, action, ...(replyFact ? { replyFact } : {}) })
            const preferences = options.group ? undefined : await readPreferences?.()
            const makeReply = (text: string, deliveryId: string, originalMessageId?: string) =>
              createImRequestedReply(event.scope, { ownerId: connection.ownerId, deliveryId, text },
                originalMessageId ?? (connection.platform === 'qq' ? event.eventId : event.platformMessageId))
            async function sendReply(reply: NonNullable<ReturnType<typeof makeReply>>, trackAcceptedFact = false, active = false): Promise<{ outcome: Outcome; replyFact?: AcceptedReplyFact }> {
              if (!await options.authorize() || options.group && !await options.group.authorizeMessage(event!)) return { outcome: 'rejected' }
              try {
                const sent = active && connection.platform === 'qq'
                  ? await options.sendActiveNotice?.(reply) ?? 'rejected'
                  : connection.platform === 'qq' && options.group && event!.platformUserName
                  ? await options.send(reply, replyContext, event!.platformUserName)
                  : await options.send(reply, replyContext)
                const outcome = typeof sent === 'string' ? sent : sent.outcome
                const ids = typeof sent === 'string' ? [] : [...new Set(sent.platformMessageIds ?? [])]
                const recipientSenderId = options.group ? event!.scope.platformUserId : null
                return { outcome, ...(trackAcceptedFact && outcome === 'accepted' && ids.length && recipientSenderId
                  ? { replyFact: { platformMessageIds: ids, recipientSenderId, sentAtMs: Date.now(),
                    ...(envelope?.sourceAttentionKind ? { sourceAttentionKind: envelope.sourceAttentionKind } : {}) } } : {}) }
              } catch { return { outcome: 'unknown' } }
            }
            async function sendNotice(key: string, text: string, kind: QqNoticeKind = 'reply') {
              const noticeKey = createHash('sha256').update(JSON.stringify([clientId, key])).digest('hex')
              const qq = connection.platform === 'qq' ? resolveQqNoticeTarget(kind, event!.eventId) : undefined
              if (qq?.mode === 'rejected') return 'rejected'
              const reply = qq?.mode === 'active'
                ? createImRequestedReply(event!.scope, { ownerId: connection.ownerId, deliveryId: noticeKey, text })
                : makeReply(text, noticeKey, qq?.messageId)
              if (!reply || !await options.authorize()) return
              if (!await update('begin', noticeKey)) return
              const { outcome } = await sendReply(reply, false, qq?.mode === 'active')
              await update(outcome, noticeKey)
              return outcome
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
              const page = await callRpc<DesktopAgentEventPage>('agent.sessions.events', { id: item.sessionId, runId: item.runId, after: current.cursor, imDelivery: true, ...(current.stream ? { imStream: true } : {}) })
              for (const entry of page.events) {
                if (entry.type === 'im_stream' && current.stream && current.streamOutcome !== 'unknown' && current.streamOutcome !== 'rejected') {
                  const runEvent = entry.runEvent as RunEvent
                  current.streamOutcome = await current.stream.project(runEvent)
                  if (runEvent.type === 'final') current.streamFinal = true
                }
                if (entry.type === 'im_compaction' && typeof entry.sequence === 'number'
                  && !options.group && (connection.platform === 'feishu' || preferences?.imToolDisplayMode !== 'off')) {
                  const notice = formatImCompactionNotice({ phase: entry.phase, applied: entry.applied })
                  if (notice) {
                    if (connection.platform === 'qq' && current.stream && entry.phase === 'started'
                      && current.streamOutcome !== 'unknown' && current.streamOutcome !== 'rejected') {
                      current.streamOutcome = await current.stream.project(entry.runEvent as RunEvent)
                    }
                    if (current.streamOutcome !== 'unknown' && current.streamOutcome !== 'rejected')
                      await sendNotice(`compaction:${entry.sequence}`, notice, 'compaction')
                  }
                }
                if (entry.type === 'round_start') current.sentRound = undefined
                if (entry.type === 'im_round_end' && typeof entry.sequence === 'number' && typeof entry.text === 'string' && entry.text.trim()
                  && !current.stream && preferences?.showIntermediateReplies) {
                  const outcome = await sendNotice(`round:${entry.sequence}`, entry.text)
                  current.sentRound = { text: entry.text, outcome: outcome ?? 'unknown' }
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
                    name: message.toolName, status: message.toolStatus, display: message,
                  }, redactToolError, preferences?.locale), 'tool')
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
              if (await callRpc<boolean>('im.inbox.prompt', { ...request, action: 'begin' })) {
                let messageId: string | null = null
                try { if (await options.authorize()) messageId = await options.sendPrompt(prompt, options.userId) }
                finally { await callRpc('im.inbox.prompt', { ...request, action: 'settle', messageId }) }
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
                else if (status === 'completed' && current.sentRound?.text === text) await update(current.sentRound.outcome)
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
            const errorCode = error instanceof DesktopError ? error.code : 'internal_error'
            const signature = JSON.stringify([rpcMethod, errorCode])
            if (signature !== lastFailure) {
              report?.(errorCode === 'model_unavailable' ? 'im_model_unavailable' : 'dispatch_unavailable', error, rpcMethod)
              lastFailure = signature
            }
          }
          // 收件已持久化，下次迭代从原状态恢复。
        } finally {
          if (!retryRequired) {
            lastFailure = undefined
            retryDelay = 1_000
          }
          if (!keepTyping || signal.aborted) await stopTyping()
        }
        if (!retryRequired && change !== observed) continue
        const wake = new AbortController()
        if (!retryRequired) pendingWake = wake
        try {
          // 通知只唤醒读取。定时补读覆盖漏通知和未关联运行的入站消息。
          await delay(retryDelay, undefined, { signal: AbortSignal.any([signal, wake.signal]) }).catch(() => {})
          if (retryRequired) retryDelay = Math.min(30_000, retryDelay * 2)
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
