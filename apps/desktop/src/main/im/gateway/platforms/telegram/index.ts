import { redactToolError } from '@gugu/core/agent'
import { attentionSourceKind } from '@gugu/core/im/attention/directive'
import { createDesktopImChartRenderer, createDesktopImProjectionReceipts } from '../../delivery/projection.js'
import { readDesktopAgentAttachmentContent } from '../../../../agent/attachments.js'
import type { IpcHost } from '../../../../ipc/types.js'
import { transcribeDesktopImFile, type DesktopImVoice } from '../../inbound/voice.js'
import { IM_BINDING_TTL_SECONDS, IM_BINDING_MAX_ATTEMPTS } from '@gugu/core/im/binding-code'
import { updateUserBotGroupTools, userBotGroupToolFlags } from '@gugu/core/im/user-bots'
import { classifyImGroupInbound, resolveImActor } from '@gugu/core/im/access'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { createGatewaySupervisor, createImGroupAttentionGate, parseImReceivedMessage, readImReceivedMessage, type ImGroupAttentionHistory, type ImReceivedMessage } from '@gugu/gateway'
import { handleTelegramBinding, createTelegramAdapter, createPersistentTelegramProjection, processTelegramAttachments, telegramAttachmentReference, TelegramApiError, verifyTelegramBotIdentity } from '@gugu/gateway/telegram'
import { createNodeProviderTransport, desktopTransportOptions } from '@gugu/core/providers/node'
import type { DesktopTelegramMessage, DesktopTelegramSnapshot } from '@gugu/core/desktop'
import { createEncryptedDesktopStore } from '../../../../auth/store.js'
import { DesktopError } from '../../../../core-host.js'
import { createDesktopTelegramConfig, parseDesktopTelegramBot, validTelegramPrivateId, type DesktopTelegramBot, type DesktopTelegramEncryption } from '../../../connect/platforms/telegram/index.js'

import type { createDesktopImCallback } from '../../interactions/callback.js'
import { desktopImEventKey, type DesktopImFile, type createDesktopImInbox } from '../../inbound/inbox.js'
import type { createDesktopImDispatch } from '../../delivery/dispatch.js'

type Inbox = { cursor: number | null; messages: DesktopTelegramMessage[] }
const inboxLimit = 100
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
function parseInbox(value: unknown): Inbox {
  if (!isRecord(value) || (value.cursor !== null && !Number.isSafeInteger(value.cursor))
      || !Array.isArray(value.messages) || value.messages.length > inboxLimit
      || !value.messages.every(item => isRecord(item) && Number.isSafeInteger(item.id) && typeof item.text === 'string'
        && typeof item.receivedAt === 'string')) throw new Error('Telegram 收件箱格式无效')
  return { cursor: value.cursor as number | null, messages: value.messages as DesktopTelegramMessage[] }
}

export function createDesktopTelegramGateway(directory: string, encryption: DesktopTelegramEncryption, connect = createTelegramAdapter,
  resolveProxy?: NonNullable<Parameters<typeof createNodeProviderTransport>[0]>['resolveProxy'],
  admit?: ReturnType<typeof createDesktopImInbox>, dispatch?: ReturnType<typeof createDesktopImDispatch>, callback?: ReturnType<typeof createDesktopImCallback>, voice?: DesktopImVoice, attachmentHost?: IpcHost) {
  const store = createDesktopTelegramConfig(directory, encryption)
  const emptyInbox: Inbox = { cursor: null, messages: [] }
  const botId = (bot: DesktopTelegramBot) => bot.token.split(':', 1)[0]!
  const inboxes = new Map<string, ReturnType<typeof createEncryptedDesktopStore<Inbox>>>()
  const connectionId = (bot: DesktopTelegramBot) => createHash('sha256').update(JSON.stringify([botId(bot), bot.chatId])).digest('hex')
  const groupConnectionId = (bot: DesktopTelegramBot, groupId: string) =>
    createHash('sha256').update(JSON.stringify(['telegram-group', botId(bot), groupId, bot.chatId])).digest('hex')
  const inboxFor = (bot: DesktopTelegramBot) => {
    const scope = connectionId(bot)
    let inbox = inboxes.get(scope)
    if (!inbox) {
      inbox = createEncryptedDesktopStore(directory, `im-telegram-inbox-${scope}`, encryption, parseInbox)
      inboxes.set(scope, inbox)
    }
    return inbox
  }
  let binding: { code: string; expiresAt: number; revision: string; attempts: number } | undefined
  let pollStatus: { revision: string; status: 'ready' | 'conflict' | 'retrying' } | undefined
  const gateway = createGatewaySupervisor({
    async read() {
      const bot = await store.read()
      return bot?.enabled ? [{ ...bot, key: 'telegram' }] : []
    },
    // 本机配置通过服务入口提交，提交后直接通知共享监督器。
    async subscribe() { return { disconnected: new Promise<void>(() => {}), async close() {} } },
    async connect(bot, signal) {
      pollStatus = undefined
      const inbox = inboxFor(bot)
      let current = await inbox.read() ?? emptyInbox
      const adapter = connect({ token: bot.token, transport: createNodeProviderTransport(desktopTransportOptions(false, resolveProxy)) })
      const connection = { ownerId: 'desktop', botId: botId(bot), platform: 'telegram' as const }
      const controller = new AbortController()
      const dispatchSignal = AbortSignal.any([signal, controller.signal])
      const groupDeliveries = new Map<string, Promise<void>>()
      const groupAttention = createImGroupAttentionGate()
      async function authorize() {
        if (dispatchSignal.aborted) return false
        const latest = await store.read()
        return !dispatchSignal.aborted && latest?.enabled === true && latest.revision === bot.revision
      }
      async function authorizeGroup(groupId: string) {
        if (!await authorize()) return false
        const latest = await store.read()
        return !!latest?.chatId && latest.groupChatEnabled && !dispatchSignal.aborted
          && groupConnectionId(latest, groupId) !== ''
      }
      function startGroupDispatch(groupId: string) {
        const id = groupConnectionId(bot, groupId)
        const allow = () => authorizeGroup(groupId)
        const allowMessage = async (message: ImReceivedMessage) => {
          const latest = await store.read()
          return !!latest?.chatId && latest.groupChatEnabled && latest.groupReplyMode !== 'record_only'
            && (message.botMentioned || latest.groupReplyMode === 'reply_all') && !dispatchSignal.aborted
        }
        const allowFile = async (message: ImReceivedMessage) => {
          const latest = await store.read()
          return !!latest?.chatId && latest.groupChatEnabled && latest.groupReplyMode !== 'record_only'
            && latest.groupAllowedTools.some(tool => ['http_get', 'similar_image_search', 'send_file'].includes(tool))
            && (message.botMentioned || latest.groupReplyMode === 'reply_all') && !dispatchSignal.aborted
        }
        if (!groupDeliveries.has(id) && dispatch) {
          const work = dispatch({ connection, connectionId: id, signal: dispatchSignal, authorize: allow,
            group: { id: groupId, ownerPlatformUserId: bot.chatId!, authorizeMessage: allowMessage, authorizeFile: allowFile },
            media: { platform: 'telegram', sender: adapter.sender },
            async send(reply) {
              if (reply.recipient !== groupId || !reply.originalMessageId || !await allow()) return 'rejected'
              return await adapter.sender.text({ chatId: groupId, chatType: 'group', replyToMessageId: reply.originalMessageId },
                reply.text, { signal: dispatchSignal, authorize: allow })
            },
          }).finally(() => { groupDeliveries.delete(id) })
          groupDeliveries.set(id, work)
          void work.catch(() => {})
        }
        return id
      }
      let recovery: Promise<void> | undefined
      async function recoverGroups() {
        if (!attachmentHost) return
        let after = ''
        while (!dispatchSignal.aborted) {
          const current = await store.read()
          if (!current?.enabled || !current.chatId || !current.groupChatEnabled || current.groupReplyMode === 'record_only') return
          const row = await attachmentHost.request<{ connectionId: string; eventKey: string; sealedEvent: string } | null>(
            'im.inbox.pendingConnection', { platform: 'telegram', after })
          if (!row || typeof row.connectionId !== 'string' || !row.connectionId
            || row.connectionId <= after || typeof row.eventKey !== 'string' || !row.eventKey
            || typeof row.sealedEvent !== 'string' || !row.sealedEvent) return
          after = row.connectionId
          try {
            const { result } = await encryption.decryptStringAsync(Buffer.from(row.sealedEvent, 'base64'))
            const message = parseImReceivedMessage(connection, JSON.parse(result).event)
            const { chatType, chatId } = message.scope
            if (chatType !== 'group' || !chatId || desktopImEventKey(message) !== row.eventKey
              || groupConnectionId(current, chatId) !== row.connectionId
              || (!message.botMentioned && current.groupReplyMode !== 'reply_all')) continue
            startGroupDispatch(chatId)
          } catch { /* 无法恢复的密封收件由 Core 保留原有失败状态。 */ }
        }
      }
      let mediaNotice: { updateId: number; text: string; messageId: string } | undefined
      const handle = await adapter.connect({
        botId: botId(bot), ownerId: 'desktop', expectedPlatformBotId: botId(bot), signal,
        onPollStatus(status) { if (!signal.aborted) pollStatus = { revision: bot.revision, status } },
        async preflight(message) {
          const event = readImReceivedMessage(connection, { ...message })
          if (message.telegram_command === 'bind') {
            const sender = event.scope.platformUserId
            const cursor = Number(message.platform_event_id)
            if (event.scope.chatType === 'c2c' && validTelegramPrivateId(sender) && sender === message.chat_id
              && Number.isSafeInteger(cursor) && cursor >= 0) {
              let boundRevision: string | undefined
              try {
                await handleTelegramBinding(event.text, code => serialize(async () => {
                  const challenge = binding
                  if (bot.chatId || !challenge || challenge.revision !== bot.revision || challenge.expiresAt <= Date.now()
                    || challenge.attempts >= IM_BINDING_MAX_ATTEMPTS || stopping || !await authorize()) return false
                  if (challenge.code !== code) { challenge.attempts++; return false }
                  const bound = { ...bot, chatId: sender, revision: randomUUID() }
                  const target = inboxFor(bound)
                  const previous = await target.read() ?? emptyInbox
                  await target.write({ ...previous, cursor: Math.max(previous.cursor ?? 0, cursor) })
                  await store.write(bound)
                  boundRevision = bound.revision
                  binding = undefined
                  return true
                }), async text => {
                  try {
                    await adapter.sender.text({ chatId: sender, chatType: 'c2c' }, text, {
                      signal: dispatchSignal,
                      authorize: async () => {
                        const latest = await store.read()
                        return !dispatchSignal.aborted && latest?.enabled === true
                          && latest.revision === (boundRevision ?? bot.revision)
                      },
                    })
                  } catch { /* 已保存的绑定不随平台回执回滚。 */ }
                })
              } finally {
                if (boundRevision) gateway.refresh()
              }
            }
            return 'consumed'
          }
          if (!bot.chatId || !(event.text.trim() || admit && message.attachments.length)) return 'consumed'
          if (event.scope.chatType === 'c2c')
            return message.chat_id === bot.chatId && event.scope.platformUserId === bot.chatId ? 'enqueue' : 'consumed'
          const latest = await store.read()
          if (event.scope.chatType !== 'group' || !latest?.enabled || !latest.chatId
            || !latest.groupChatEnabled || !event.scope.chatId) return 'consumed'
          const decision = classifyImGroupInbound({ platform: 'telegram', chatType: 'group', chatId: event.scope.chatId,
            groupMentioned: event.botMentioned, mentionsOtherBot: false },
          { requiresAt: latest.groupReplyMode !== 'reply_all', readOnly: false })
          return latest.groupReplyMode === 'record_only' || decision === 'reply' ? 'enqueue' : 'consumed'
        },
        async materialize(payload, signal) {
          mediaNotice = undefined
          if (current.cursor !== null && Number(payload.platform_event_id) <= current.cursor) return null
          if (!await authorize()) throw new DesktopError('cancelled', 'IM 连接已变更')
          const isGroup = payload.chat_type === 'group'
          const groupId = isGroup && typeof payload.chat_id === 'string' ? payload.chat_id : null
          const latest = isGroup ? await store.read() : null
          if (isGroup && (!groupId || !latest?.chatId || !latest.groupChatEnabled)) return null
          let recordOnly = isGroup && latest?.groupReplyMode === 'record_only'
          let sourceAttentionKind = isGroup && payload.bot_mentioned === true ? attentionSourceKind('DIRECT') : null
          const eventAuthorize = isGroup && groupId ? () => authorizeGroup(groupId) : authorize
          const eventConnectionId = isGroup && groupId ? groupConnectionId(bot, groupId) : connectionId(bot)
          const files: DesktopImFile[] = []
          if (admit && attachmentHost && !isGroup) {
            for (const quoted of payload.quoted_attachments) {
              const reference = telegramAttachmentReference(quoted)
              if (!reference || !await authorize()) continue
              const stored = await attachmentHost.request<(Parameters<typeof readDesktopAgentAttachmentContent>[2] & {
                attachId: string; kind: string; transcript: string | null
              }) | null>('im.inbox.attachmentReference', { ...reference, platform: 'telegram', connectionId: connectionId(bot) })
              if (!stored) continue
              try {
                const file = await readDesktopAgentAttachmentContent(directory, stored.attachId, stored)
                files.push({ name: file.displayName, ext: file.ext, mime: file.mime, bytes: file.data,
                  voice: stored.kind === 'voice', ...(stored.transcript ? { transcript: stored.transcript } : {}) })
              } catch (error) {
                if (!(error instanceof DesktopError && error.code === 'not_found')) throw error
              }
            }
          }
          if (admit && payload.attachments.length) {
            const result = await processTelegramAttachments(adapter.api, bot.token, payload.attachments, signal, async (file, signal) => {
              files.push(await transcribeDesktopImFile({ name: file.name, ext: file.ext, mime: file.mime, bytes: file.data, voice: file.kind === 'voice', sourceIndex: file.attachmentIndex }, voice, signal, eventAuthorize))
            }, eventAuthorize)
            if (result.failureNotice) mediaNotice = {
              updateId: Number(payload.platform_event_id), messageId: payload.message_id, text: result.failureNotice,
            }
          }
          signal.throwIfAborted()
          if (!await authorize()) throw new DesktopError('cancelled', 'IM 连接已变更')
          if (!payload.text.trim() && !files.length) return null
          if (isGroup && groupId && latest && !recordOnly && latest.groupReplyMode === 'reply_all') {
            const attentionHistory = attachmentHost
              ? await attachmentHost.request<ImGroupAttentionHistory>('im.inbox.groupAttentionHistory', {
                platform: 'telegram', connectionId: groupConnectionId(latest, groupId),
              })
              : undefined
            const attention = groupAttention.evaluate({ platform: 'telegram', botId: botId(bot), groupId,
              mode: latest.groupAttentionMode,
              payload: { ...payload, processable_media: files.length > 0 } }, attentionHistory)
            recordOnly = !attention.run
            sourceAttentionKind = attentionSourceKind(attention.decision.kind)
          }
          const ready = { ...payload, attachments: [], quoted_attachments: [] }
          if (admit) {
            const event = readImReceivedMessage(connection, ready)
            if (recordOnly) await admit(eventConnectionId, event, undefined, { files, recordOnly, ownerPlatformUserId: bot.chatId!, authorize: eventAuthorize })
            else {
              if (isGroup && groupId) startGroupDispatch(groupId)
              if (files.length) await admit(eventConnectionId, event, undefined, { files, authorize: eventAuthorize,
                sourceAttentionKind: sourceAttentionKind ?? undefined, sourceMessageId: payload.attachment_source_message_id ?? undefined })
              else if (isGroup) await admit(eventConnectionId, event, undefined, { files: [], sourceAttentionKind: sourceAttentionKind ?? undefined, authorize: eventAuthorize })
              else await admit(eventConnectionId, event)
            }
          }
          return ready
        },
        async callback(data, signal) {
          if (!callback || !bot.chatId || typeof data.id !== 'string') return true
          let accepted = false
          try { accepted = await callback(connection, connectionId(bot), bot.chatId, data, authorize) }
          catch { /* 回调验证或消费失败，返回通用状态。 */ }
          try { await adapter.api.call(bot.token, 'answerCallbackQuery', { payload: {
            callback_query_id: data.id, text: accepted ? '已收到选择' : '交互已失效', show_alert: !accepted,
          }, signal, authorize }) } catch { /* 平台提示失败不重放已消费动作。 */ }
          return true
        },
        inbox: {
          async cursor() { return current.cursor },
          async commit(id, payload) {
            if (current.cursor !== null && id <= current.cursor) return
            const messages = payload && payload.chat_type === 'c2c' && typeof payload.text === 'string'
              ? [...current.messages, { id, text: payload.text, receivedAt: new Date().toISOString() }].slice(-inboxLimit)
              : current.messages
            const next = { cursor: id, messages }
            await inbox.write(next)
            current = next
            const notice = mediaNotice
            mediaNotice = undefined
            if (notice?.updateId === id && bot.chatId) {
              // 游标先落盘，提示发送失败或结果未知都不会重放本条消息。
              const signal = AbortSignal.any([dispatchSignal, AbortSignal.timeout(5_000)])
              const groupId = payload?.chat_type === 'group' && typeof payload.chat_id === 'string' ? payload.chat_id : null
              const noticeAuthorize = groupId ? () => authorizeGroup(groupId) : authorize
              try {
                if (!await noticeAuthorize()) return
                await adapter.sender.text({ chatId: groupId ?? bot.chatId, chatType: groupId ? 'group' : 'c2c', replyToMessageId: notice.messageId },
                  notice.text, { signal, authorize: noticeAuthorize })
              } catch { /* 提示失败不影响已完成的收件。 */ }
            }
          },
        },
      })
      if (attachmentHost) recovery = recoverGroups().catch(() => {}).finally(() => { recovery = undefined })
      if (!dispatch || !bot.chatId) return handle
      const delivery = dispatch({ connection, connectionId: connectionId(bot), userId: bot.chatId,
        signal: dispatchSignal, authorize, media: { platform: 'telegram', sender: adapter.sender },
        ...(attachmentHost && bot.privateStreamingEnabled ? { async createStream(target) {
          if (!target.referenceMessageId || !/^[1-9]\d*$/.test(target.referenceMessageId)) return
          const receipts = createDesktopImProjectionReceipts(attachmentHost, encryption, {
            platform: 'telegram', connectionId: connectionId(bot), eventKey: target.eventKey, runId: target.runId,
          })
          const checkpoint = await receipts.projection.read()
          if (!checkpoint.version && checkpoint.plain) return
          const recipient = { chatId: bot.chatId!, chatType: 'c2c', replyToMessageId: target.referenceMessageId } as const
          let stream: ReturnType<typeof createPersistentTelegramProjection> | undefined
          return {
            async project(event) {
              if (event.identity.runId !== target.runId || event.identity.sessionId !== String(target.sessionId))
                throw new Error('本机 Telegram 流式运行身份不匹配')
              stream ??= createPersistentTelegramProjection({
                identity: event.identity, receipts, sender: adapter.sender, target: recipient,
                authorize, signal: dispatchSignal, policyVersion: 'desktop-telegram-v1',
                showIntermediateReplies: target.preferences?.showIntermediateReplies,
                toolSummary: target.preferences?.imToolDisplayMode === 'all'
                  ? { chatType: 'p2p', includeDetails: false, sanitize: redactToolError } : undefined,
                renderCharts: createDesktopImChartRenderer(attachmentHost, authorize),
              })
              const result = await stream.project({ identity: event.identity, deliveryId: event.id, event })
              return typeof result === 'string' ? result : result.outcome
            },
            async close() { await stream?.close() },
          }
        } } : {}),
        ...(callback ? { async sendPrompt(prompt: Parameters<typeof adapter.sender.interaction>[1], recipient: string) {
          const receipt = await adapter.sender.interaction({ chatId: recipient, chatType: 'c2c' }, prompt, dispatchSignal, authorize)
          return receipt.outcome === 'accepted' && receipt.platformMessageIds.length === 1 ? receipt.platformMessageIds[0]! : null
        } } : {}),
        async send(reply) {
          return (await adapter.sender.text({ chatId: reply.recipient, chatType: 'c2c',
            replyToMessageId: reply.originalMessageId }, reply.text,
            { signal: dispatchSignal, authorize })).outcome
        },
      })
      const closed = handle.closed.finally(() => controller.abort()).then(async () => {
        await recovery
        await delivery
        await Promise.allSettled(groupDeliveries.values())
      })
      void closed.catch(() => {})
      return { closed, async stop() { controller.abort(); try { await handle.stop() } finally { await delivery } } }
    },
  })

  let pending = Promise.resolve<unknown>(undefined)
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation)
    pending = result.catch(() => undefined)
    return result
  }

  async function snapshot(): Promise<DesktopTelegramSnapshot> {
    const bot = await store.read()
    const health = gateway.health()
    const currentPoll = pollStatus?.revision === bot?.revision ? pollStatus?.status : undefined
    return {
      configured: !!bot,
      bound: !!bot?.chatId,
      ...(binding && binding.expiresAt > Date.now() && binding.attempts < IM_BINDING_MAX_ATTEMPTS
        ? { binding: { code: binding.code, expiresAt: binding.expiresAt } } : {}),
      enabled: bot?.enabled ?? false,
      status: health.cleanupUnknown ? 'cleanup_failed' : !bot?.enabled ? 'disabled'
        : currentPoll === 'conflict' ? 'conflict' : currentPoll === 'retrying' || health.retrying ? 'retrying'
          : currentPoll === 'ready' && health.running ? 'connected' : 'connecting',
      messages: bot?.chatId ? (await inboxFor(bot).read())?.messages ?? [] : [],
      ...(bot ? {
        privateStreamingEnabled: bot.privateStreamingEnabled,
        groupChatEnabled: bot.groupChatEnabled, groupReplyMode: bot.groupReplyMode,
        groupAttentionMode: bot.groupAttentionMode,
        ...userBotGroupToolFlags(bot.groupAllowedTools),
        groupOwnerMemoryEnabled: bot.groupOwnerMemoryEnabled, groupMemoryEnabled: bot.groupMemoryEnabled,
        memberMemoryEnabled: bot.memberMemoryEnabled,
      } : {}),
    }
  }

  async function readAuthorizedGroupMessage(params: Record<string, unknown>, signal: AbortSignal) {
    const { connectionId: requestedConnection, eventKey, sealedEvent } = params
    if (signal.aborted || typeof requestedConnection !== 'string' || typeof eventKey !== 'string'
      || typeof sealedEvent !== 'string' || sealedEvent.length > 48_000) return null
    try {
      const { result } = await encryption.decryptStringAsync(Buffer.from(sealedEvent, 'base64'))
      const current = await store.read()
      if (signal.aborted || !current?.enabled || !current.chatId || !current.groupChatEnabled || current.groupReplyMode === 'record_only') return null
      const connection = { platform: 'telegram', ownerId: 'desktop', botId: botId(current) } as const
      const message = parseImReceivedMessage(connection, JSON.parse(result).event)
      const { chatType, chatId } = message.scope
      if (chatType !== 'group' || !chatId || desktopImEventKey(message) !== eventKey
        || groupConnectionId(current, chatId) !== requestedConnection
        || (!message.botMentioned && current.groupReplyMode !== 'reply_all')) return null
      return { current, message }
    } catch { return null }
  }

  let stopping: Promise<void> | undefined
  return {
    async start() { await gateway.start() },
    stop() { return stopping ??= gateway.stop() },
    snapshot: () => serialize(snapshot),
    save: (input: unknown) => serialize(async () => {
      if (stopping) throw new DesktopError('busy', '网关正在停止')
      if (!isRecord(input)) throw new DesktopError('invalid_request', 'Telegram 配置无效')
      const next = parseDesktopTelegramBot({ token: input.token, chatId: null, enabled: true, revision: randomUUID() })
      const { api } = connect({ token: next.token, transport: createNodeProviderTransport(desktopTransportOptions(false, resolveProxy)) })
      const signal = AbortSignal.timeout(45_000)
      let identity: Awaited<ReturnType<typeof verifyTelegramBotIdentity>>
      try {
        identity = await verifyTelegramBotIdentity(method => api.call(next.token, method, { signal }), botId(next))
      } catch (error) {
        if (error instanceof TelegramApiError && (error.errorCode === 401 || error.errorCode === 404))
          throw new DesktopError('invalid_request', 'Telegram Bot Token 无效')
        throw new DesktopError('im_pairing_failed', '暂时无法验证 Telegram Bot，请稍后重试')
      } finally { await api.close() }
      if (identity.webhookUrl.trim()) throw new DesktopError('conflict', '该 Bot 已配置 Webhook；请先在 Telegram 侧移除 Webhook 后再接入')
      if (stopping) throw new DesktopError('busy', '网关正在停止')
      const previous = await store.read()
      if (previous && botId(previous) === botId(next)) Object.assign(next, {
        chatId: previous.chatId, groupChatEnabled: previous.groupChatEnabled,
        privateStreamingEnabled: previous.privateStreamingEnabled,
        groupReplyMode: previous.groupReplyMode, groupAttentionMode: previous.groupAttentionMode,
        groupAllowedTools: previous.groupAllowedTools, groupOwnerMemoryEnabled: previous.groupOwnerMemoryEnabled,
        groupMemoryEnabled: previous.groupMemoryEnabled, memberMemoryEnabled: previous.memberMemoryEnabled,
      })
      await store.write(next)
      binding = undefined
      gateway.refresh()
      return snapshot()
    }),
    bindingCode: () => serialize(async () => {
      const bot = await store.read()
      if (stopping || !bot?.enabled || bot.chatId) throw new DesktopError('conflict', '当前机器人无法生成绑定码')
      binding = { code: String(randomInt(1_000_000)).padStart(6, '0'), expiresAt: Date.now() + IM_BINDING_TTL_SECONDS * 1000,
        revision: bot.revision, attempts: 0 }
      return snapshot()
    }),
    enable: () => serialize(async () => {
      if (stopping) throw new DesktopError('busy', '网关正在停止')
      const bot = await store.read()
      if (!bot) throw new DesktopError('invalid_request', '请先配置 Telegram Bot')
      if (!bot.enabled) {
        await store.write({ ...bot, enabled: true, revision: randomUUID() })
        gateway.refresh()
      }
      return snapshot()
    }),
    async disable() {
      await serialize(async () => {
        if (stopping) throw new DesktopError('busy', '网关正在停止')
        const bot = await store.read()
        if (bot?.enabled) {
          await store.write({ ...bot, enabled: false })
          binding = undefined
          gateway.refresh()
        }
      })
      await gateway.settled()
      return serialize(snapshot)
    },
    async authorizeGroupTool(params: Record<string, unknown>, signal: AbortSignal) {
      const authorized = await readAuthorizedGroupMessage(params, signal)
      if (!authorized || typeof params.name !== 'string') return false
      return authorized.current.groupAllowedTools.includes(params.name) && !signal.aborted
    },
    async readGroupMemoryContext(params: Record<string, unknown>, signal: AbortSignal) {
      const authorized = await readAuthorizedGroupMessage(params, signal)
      if (!authorized || typeof params.ownerId !== 'string' || !params.ownerId) return null
      const { current, message } = authorized
      const actor = resolveImActor({ ownerId: params.ownerId, botId: botId(current), platform: 'telegram',
        platformUserId: message.scope.platformUserId, chatType: 'group', chatId: message.scope.chatId,
        botMentioned: message.botMentioned, mentionsOtherBot: false,
        speakers: [{ platformUserId: message.scope.platformUserId }],
      }, scope => ({ role: scope.platformUserId === current.chatId ? 'owner' : 'member', allowedToolNames: [] }))
      return { actor, groupMemoryEnabled: current.groupMemoryEnabled,
        groupOwnerMemoryEnabled: current.groupOwnerMemoryEnabled, memberMemoryEnabled: current.memberMemoryEnabled }
    },
    updateGroupSettings: (patch: import('@gugu/core/desktop').DesktopImGroupSettingsPatch) => serialize(async () => {
      if (stopping) throw new DesktopError('busy', '网关正在停止')
      const current = await store.read()
      if (!current) throw new DesktopError('invalid_request', '请先配置 Telegram Bot')
      if (!current.chatId) throw new DesktopError('conflict', '请先绑定 Telegram 私聊身份')
      const { groupWebToolsEnabled, groupProviderSearchEnabled, groupHistorySearchEnabled, ...settings } = patch
      const groupAllowedTools = updateUserBotGroupTools(current.groupAllowedTools,
        { groupWebToolsEnabled, groupProviderSearchEnabled, groupHistorySearchEnabled })
      await store.write({ ...current, ...settings, groupAllowedTools })
      return snapshot()
    }),
    setPrivateStreaming: (enabled: boolean) => serialize(async () => {
      if (stopping) throw new DesktopError('busy', '网关正在停止')
      const current = await store.read()
      if (!current) throw new DesktopError('invalid_request', '请先配置 Telegram Bot')
      if (current.privateStreamingEnabled !== enabled) {
        await store.write({ ...current, privateStreamingEnabled: enabled, revision: randomUUID() })
        gateway.refresh()
      }
      return snapshot()
    }),
  }
}
