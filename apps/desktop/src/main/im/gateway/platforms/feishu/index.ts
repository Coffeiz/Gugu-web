import { classifyGatewayGroupMessage } from '@gugu/gateway'
import { readImAddressedCommand } from '@gugu/gateway'
import { desktopImGroupToolAllowed } from '@gugu/core/agent/scenes/im'
import { redactToolError } from '@gugu/core/agent'
import { attentionSourceKind } from '@gugu/core/im/attention/directive'
import { resolveImActor } from '@gugu/core/im/access'
import { userBotGroupFileToolsAllowed } from '@gugu/core/im/user-bots'
import { createDesktopImChartRenderer, createDesktopImProjectionReceipts } from '../../delivery/projection.js'
import type { IpcHost } from '../../../../ipc/types.js'
import type { safeStorage } from 'electron'
import { DesktopError } from '../../../../core-host.js'
import { transcribeDesktopImFile, type DesktopImVoice } from '../../inbound/voice.js'
import { createHash } from 'node:crypto'
import { FeishuMediaIngressError, parseFeishuEvent, processFeishuMedia, readFeishuQuote } from '@gugu/gateway/feishu'
import { createGatewaySupervisor, createImGroupAttentionGate, readImReceivedMessage, type ImGroupAttentionHistory,
  type ImPendingAskStore } from '@gugu/gateway'
import { createPersistentFeishuProjection, createFeishuClient, createFeishuConnection, createFeishuSender, createFeishuWsNetwork } from '@gugu/gateway/feishu'
import type { createDesktopFeishuPairing } from '../../../connect/platforms/feishu/index.js'
import type { createDesktopImCallback } from '../../interactions/callback.js'
import { readDesktopImRunStatus, stopDesktopImRun, type createDesktopImDispatch } from '../../delivery/dispatch.js'
import { MAX_DESKTOP_ATTACHMENT_BYTES } from '../../../../agent/attachments.js'
import { desktopImEventKey, type DesktopImFile, type createDesktopImInbox } from '../../inbound/inbox.js'
import { parseImReceivedMessage } from '@gugu/gateway'
import { startDesktopImPendingAskPump } from '../../inbound/pending-asks.js'

type Transport = NonNullable<Parameters<typeof createFeishuClient>[0]['transport']>
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function groupConnectionId(botId: string, groupId: string, ownerId: string) {
  return createHash('sha256').update(JSON.stringify(['feishu-group', botId, groupId, ownerId])).digest('hex')
}

export function createDesktopFeishuGateway(pairing: Pick<ReturnType<typeof createDesktopFeishuPairing>, 'read'>,
  admit: ReturnType<typeof createDesktopImInbox>, dispatch: ReturnType<typeof createDesktopImDispatch>,
  transport: () => Transport, connect = createFeishuConnection, callback?: ReturnType<typeof createDesktopImCallback>, voice?: DesktopImVoice,
  projection?: { host: IpcHost; encryption: Pick<typeof safeStorage, 'encryptStringAsync' | 'decryptStringAsync'> }, pendingAsks?: ImPendingAskStore) {
  const supervisor = createGatewaySupervisor({
    async read() {
      const bot = await pairing.read()
      return bot?.enabled ? [{ ...bot, key: 'feishu' }] : []
    },
    async subscribe() { return { disconnected: new Promise<void>(() => {}), async close() {} } },
    async connect(bot, signal) {
      const connection = { platform: 'feishu', ownerId: 'desktop', botId: bot.appId } as const
      const connectionId = createHash('sha256').update(JSON.stringify([bot.appId, bot.userId])).digest('hex')
      const client = createFeishuClient({ appId: bot.appId, appSecret: bot.appSecret, transport: transport() })
      const sender = createFeishuSender({ client })
      const controller = new AbortController()
      const active = AbortSignal.any([signal, controller.signal])
      const groupDeliveries = new Map<string, Promise<void>>()
      const groupAttention = createImGroupAttentionGate()
      async function readActive() {
        if (active.aborted) return null
        const current = await pairing.read()
        return !active.aborted && current?.enabled === true && current.revision === bot.revision ? current : null
      }
      async function authorize() {
        return !!await readActive()
      }
      async function authorizeGroup(groupId: string) {
        const current = await readActive()
        return !!current?.userId && current.groupChatEnabled && !active.aborted && Boolean(groupId)
      }
      function startGroupDispatch(groupId: string, ownerPlatformUserId: string) {
        const groupConnection = groupConnectionId(bot.appId, groupId, ownerPlatformUserId)
        const allow = () => authorizeGroup(groupId)
        const allowMessage = async (message: Parameters<typeof admit>[1]) => {
          const current = await readActive()
          return !!current?.userId && current.userId === ownerPlatformUserId && current.groupChatEnabled
            && current.groupReplyMode !== 'record_only'
            && (message.botMentioned || current.groupReplyMode === 'reply_all')
        }
        const allowFile = async (message: Parameters<typeof admit>[1]) => {
          const current = await readActive()
          return !!current?.userId && current.userId === ownerPlatformUserId && current.groupChatEnabled
            && userBotGroupFileToolsAllowed(current.groupAllowedTools)
            && current.groupReplyMode !== 'record_only' && (message.botMentioned || current.groupReplyMode === 'reply_all')
        }
        if (!groupDeliveries.has(groupConnection)) {
          const work = dispatch({ connection, connectionId: groupConnection, signal: active, authorize: allow,
            group: { id: groupId, ownerPlatformUserId, authorizeMessage: allowMessage, authorizeFile: allowFile },
            async sendOwnerPrivate(text) {
              const authorized = async () => (await readActive())?.userId === ownerPlatformUserId && await allow()
              if (!await authorized()) return 'rejected'
              return (await sender.text(ownerPlatformUserId, text, active, authorized)).outcome
            },
            async send(reply) {
              if (reply.recipient !== groupId || !reply.originalMessageId || !await allow()) return 'rejected'
              return await sender.text(groupId, reply.text, active, allow)
            },
          }).finally(() => { groupDeliveries.delete(groupConnection) })
          groupDeliveries.set(groupConnection, work)
          void work.catch(() => {})
        }
        return groupConnection
      }
      let recovery: Promise<void> | undefined
      let stopPendingAskPump = () => {}
      async function recoverGroups() {
        if (!projection) return
        let after = ''
        while (!active.aborted) {
          const current = await readActive()
          if (!current?.groupChatEnabled || !current.userId || current.groupReplyMode === 'record_only') return
          const row = await projection.host.request<{ connectionId: string; eventKey: string; sealedEvent: string } | null>(
            'im.inbox.pendingConnection', { platform: 'feishu', after })
          if (!row || typeof row.connectionId !== 'string' || !row.connectionId
            || row.connectionId <= after || typeof row.eventKey !== 'string' || !row.eventKey
            || typeof row.sealedEvent !== 'string' || !row.sealedEvent) return
          after = row.connectionId
          try {
            const { result } = await projection.encryption.decryptStringAsync(Buffer.from(row.sealedEvent, 'base64'))
            const message = parseImReceivedMessage(connection, JSON.parse(result).event)
            const { chatType, chatId } = message.scope
            if (chatType !== 'group' || !chatId || desktopImEventKey(message) !== row.eventKey
              || groupConnectionId(current.appId, chatId, current.userId) !== row.connectionId
              || (!message.botMentioned && current.groupReplyMode !== 'reply_all')) continue
            startGroupDispatch(chatId, current.userId)
          } catch { /* 无法恢复的密封收件由 Core 保留原有失败状态。 */ }
        }
      }
      try {
        const response = await client.call('GET', '/open-apis/bot/v3/info', { signal: active, authorize })
        const identity = object(response.data) ? response.data.bot : response.bot
        if (!object(identity) || typeof identity.open_id !== 'string' || !identity.open_id)
          throw new Error('飞书机器人身份无效')
        const botOpenId = identity.open_id
        const parse = (data: Record<string, unknown>, eventType: string) => parseFeishuEvent(object(data.event) ? data : {
          header: { event_type: eventType, app_id: data.app_id, create_time: data.create_time, event_id: data.event_id },
          event: data,
        }, { botId: bot.appId, ownerId: connection.ownerId, appId: bot.appId, botOpenId, nowMs: Date.now() })
        const handle = await connect({
          appId: bot.appId, appSecret: bot.appSecret, signal: active, transport: transport(),
          wsNetwork: createFeishuWsNetwork({ allowDirect: true }),
          async onMessage(data, messageSignal) {
            if (!object(data) || !await authorize()) return
            const parsed = parse(data, 'im.message.receive_v1')
            if (parsed?.kind !== 'message' || parsed.payload.sender_is_bot === true
              || (!parsed.payload.text.trim() && !parsed.mediaItems.length) || !await authorize()) return
            const isGroup = parsed.payload.chat_type === 'group'
            if (isGroup) {
              const current = await readActive()
              if (!current?.userId || !current.groupChatEnabled || !parsed.payload.chat_id) return
              const decision = classifyGatewayGroupMessage({ platform: 'feishu', chatType: 'group', chatId: parsed.payload.chat_id,
                groupMentioned: parsed.payload.bot_mentioned, mentionsOtherBot: parsed.payload.mentions_other_bot === true },
              current.groupReplyMode)
              if (current.groupReplyMode !== 'record_only' && decision !== 'reply') return
            } else if (parsed.payload.platform_user_id !== bot.userId) return
            const mediaSignal = AbortSignal.any([active, messageSignal, AbortSignal.timeout(60_000)])
            const quote = await readFeishuQuote(parsed, client, botOpenId, mediaSignal, authorize)
            if (!await authorize()) return
            mediaSignal.throwIfAborted()
            const event = readImReceivedMessage(connection, { ...parsed.payload, ...quote })
            const current = await readActive()
            if (!current) return
            let recordOnly = isGroup && current.groupReplyMode === 'record_only'
            let pendingAsk = false
            let sourceAttentionKind = isGroup && event.botMentioned ? attentionSourceKind('DIRECT') : null
            if (isGroup && !recordOnly && current.groupReplyMode === 'reply_all' && !readImAddressedCommand(event).command) {
              const pendingScope = { ownerId: 'desktop', botId: bot.appId, platform: 'feishu' as const, groupId: parsed.payload.chat_id }
              await pendingAsks?.observe(pendingScope, { eventMs: Date.now(), senderId: event.scope.platformUserId,
                ownBotId: botOpenId, replyTo: typeof parsed.payload.reply_to_platform_message_id === 'string'
                  ? parsed.payload.reply_to_platform_message_id : undefined, directMention: event.botMentioned }, active)
              const attentionHistory = projection
                ? await projection.host.request<ImGroupAttentionHistory>('im.inbox.groupAttentionHistory', {
                  platform: 'feishu', connectionId: groupConnectionId(bot.appId, parsed.payload.chat_id, current.userId!),
                })
                : undefined
              const attention = groupAttention.evaluate({ platform: 'feishu', botId: bot.appId,
                groupId: parsed.payload.chat_id, mode: current.groupAttentionMode,
                payload: { ...parsed.payload, processable_media: parsed.mediaItems.length > 0 } }, attentionHistory)
              recordOnly = !attention.run
              pendingAsk = attention.pendingAsk && !parsed.mediaItems.length && Boolean(event.text.trim())
              sourceAttentionKind = attentionSourceKind(attention.decision.kind)
            }
            const targetConnection = isGroup
              ? groupConnectionId(bot.appId, parsed.payload.chat_id, current.userId!) : connectionId
            const eventAuthorize = isGroup ? () => authorizeGroup(parsed.payload.chat_id) : authorize
            const command = readImAddressedCommand(event).command
            if (!recordOnly && projection && (command?.name === 'stop' || command?.name === 'status') && !command.argument && await eventAuthorize()) {
              const reply = await (command.name === 'status' ? readDesktopImRunStatus : stopDesktopImRun)(projection.host, event, targetConnection, isGroup ? current.userId! : undefined)
              await sender.text(isGroup ? parsed.payload.chat_id : event.scope.platformUserId, reply, mediaSignal, eventAuthorize)
              return
            }
            if (!parsed.mediaItems.length) {
              if (recordOnly) {
                const recorded = await admit(targetConnection, event, undefined, { files: [], recordOnly, ownerPlatformUserId: current.userId!, authorize: eventAuthorize })
                if (recorded && pendingAsk && pendingAsks && projection) {
                  const eventKey = desktopImEventKey(event), eventMs = Date.now()
                  const sealedEvent = await projection.encryption.encryptStringAsync(JSON.stringify({ event, sourceAttentionKind,
                    pendingAskResume: true }))
                  await pendingAsks.register({ ownerId: 'desktop', botId: bot.appId, platform: 'feishu', groupId: parsed.payload.chat_id }, {
                    eventId: `${eventMs}-${eventKey}`, eventMs, platformMessageId: event.platformMessageId ?? event.eventId,
                    senderId: event.scope.platformUserId, payload: { eventKey, event, ownerPlatformUserId: current.userId,
                      sourceAttentionKind, sealedEvent: sealedEvent.toString('base64') },
                  }, active)
                }
              }
              else {
                if (isGroup) startGroupDispatch(parsed.payload.chat_id, current.userId!)
                await admit(targetConnection, event, isGroup ? undefined : parsed.payload.chat_id,
                  { files: [], sourceAttentionKind: sourceAttentionKind ?? undefined, authorize: eventAuthorize })
              }
              return
            }
            const files: DesktopImFile[] = []
            try {
              await processFeishuMedia(parsed.mediaItems, client, {
                maxBytes: MAX_DESKTOP_ATTACHMENT_BYTES, maxFiles: 16, signal: mediaSignal, authorize: eventAuthorize,
              }, async file => { files.push(await transcribeDesktopImFile(file, voice, mediaSignal, authorize)) })
              if (!await eventAuthorize()) return
              try {
              if (recordOnly) await admit(targetConnection, event, undefined, { files, recordOnly, ownerPlatformUserId: current.userId!, authorize: eventAuthorize })
                else {
                  if (isGroup) startGroupDispatch(parsed.payload.chat_id, current.userId!)
                  await admit(targetConnection, event, parsed.payload.chat_id, { files, sourceAttentionKind: sourceAttentionKind ?? undefined, authorize: eventAuthorize })
                }
              } catch (error) {
                if (!(error instanceof DesktopError && error.code === 'invalid_request')) throw error
                throw new FeishuMediaIngressError('feishu_media_stage')
              }
            } catch (error) {
              if (!(error instanceof FeishuMediaIngressError) || active.aborted || messageSignal.aborted) throw error
              const signal = AbortSignal.any([active, messageSignal, AbortSignal.timeout(5_000)])
              if (await authorize()) await sender.text(isGroup ? parsed.payload.chat_id : bot.userId, error.notice, signal, authorize)
            }
          },
          async onCardAction(data) {
            let accepted = false
            try {
              if (callback && object(data) && await authorize()) {
                const parsed = parse(data, 'card.action.trigger')
                if (parsed?.kind === 'card_action')
                  accepted = await callback(connection, connectionId, bot.userId, { ...parsed, raw: data }, authorize)
              }
            } catch { /* 平台只收到脱敏的交互结果。 */ }
            return { toast: { type: accepted ? 'info' : 'error', content: accepted ? '已收到选择' : '交互已失效' } }
          },
        })
        if (pendingAsks && projection) stopPendingAskPump = startDesktopImPendingAskPump({
          store: pendingAsks, signal: active,
          async authorize(resume, currentSignal) {
            currentSignal.throwIfAborted()
            const current = await readActive(), payload = resume.trigger.payload
            if (!current?.userId || !current.groupChatEnabled || current.groupReplyMode !== 'reply_all'
              || resume.scope.platform !== 'feishu' || resume.scope.botId !== current.appId
              || !object(payload) || typeof payload.eventKey !== 'string' || typeof payload.ownerPlatformUserId !== 'string'
              || payload.ownerPlatformUserId !== current.userId || typeof payload.sealedEvent !== 'string'
              || !object(payload.event)) return false
            const event = parseImReceivedMessage(connection, payload.event)
            return event.scope.chatType === 'group' && event.scope.chatId === resume.scope.groupId
              && event.scope.platformUserId === resume.trigger.senderId && desktopImEventKey(event) === payload.eventKey
          },
          async dispatch(resume, currentSignal) {
            currentSignal.throwIfAborted()
            const payload = resume.trigger.payload
            if (!object(payload) || typeof payload.eventKey !== 'string' || typeof payload.ownerPlatformUserId !== 'string'
              || typeof payload.sealedEvent !== 'string') throw new Error('桌面飞书延迟收件无效')
            const connectionId = groupConnectionId(bot.appId, resume.scope.groupId, payload.ownerPlatformUserId)
            const accepted = await projection.host.request<boolean>('im.inbox.resumePendingAsk', { platform: 'feishu', connectionId,
              eventKey: payload.eventKey, sealedEvent: payload.sealedEvent, ownerPlatformUserId: payload.ownerPlatformUserId,
              platformUserId: resume.trigger.senderId, text: String((payload.event as Record<string, unknown>).text ?? '') })
            if (accepted) startGroupDispatch(resume.scope.groupId, payload.ownerPlatformUserId)
          },
        })
        if (projection) recovery = recoverGroups().catch(() => {}).finally(() => { recovery = undefined })
        const delivery = dispatch({ connection, connectionId, userId: bot.userId, signal: active, authorize, media: { platform: 'feishu', sender },
          ...(projection && bot.privateStreamingEnabled ? { async createStream(target) {
            const receipts = createDesktopImProjectionReceipts(projection.host, projection.encryption, {
              platform: 'feishu', connectionId, eventKey: target.eventKey, runId: target.runId,
            })
            const checkpoint = await receipts.projection.read()
            if (!checkpoint.version && checkpoint.plain) return
            let stream: ReturnType<typeof createPersistentFeishuProjection> | undefined
            return {
              async project(event) {
                if (event.identity.runId !== target.runId || event.identity.sessionId !== String(target.sessionId))
                  throw new Error('本机飞书流式运行身份不匹配')
                stream ??= createPersistentFeishuProjection({
                  identity: event.identity, receiveId: bot.userId, policyVersion: 'desktop-feishu-v1',
                  receipts, client, authorize, signal: active,
                  toolSummary: target.preferences?.imToolDisplayMode === 'all'
                    ? { chatType: 'p2p', includeDetails: false, sanitize: redactToolError, locale: target.preferences?.locale } : undefined,
                  renderCharts: createDesktopImChartRenderer(projection.host, authorize),
                })
                const result = await stream.project({ identity: event.identity, deliveryId: event.id, event })
                return typeof result === 'string' ? result : result.outcome
              },
              async close() {},
            }
          } } : {}),
          ...(callback ? { async sendPrompt(prompt: Parameters<typeof sender.interaction>[1], recipient: string) {
            const receipt = await sender.interaction(recipient, prompt, active, authorize)
            return receipt.outcome === 'accepted' && receipt.platformMessageIds.length === 1 ? receipt.platformMessageIds[0]! : null
          } } : {}),
          async send(reply) { return (await sender.text(reply.recipient, reply.text, active, authorize)).outcome },
        })
        const closed = handle.closed.finally(async () => {
          controller.abort()
          stopPendingAskPump()
          await delivery
          await recovery
          await Promise.allSettled(groupDeliveries.values())
          await client.close()
        })
        void closed.catch(() => {})
        return { closed, async stop() { controller.abort(); try { await handle.stop() } finally { await closed } } }
      } catch (error) {
        controller.abort()
        await client.close()
        throw error
      }
    },
  })
  async function readAuthorizedGroupMessage(params: Record<string, unknown>, signal: AbortSignal, scheduled = false) {
    const { connectionId, eventKey, sealedEvent } = params
    if (!projection || signal.aborted || typeof connectionId !== 'string' || typeof eventKey !== 'string'
      || typeof sealedEvent !== 'string' || sealedEvent.length > 48_000) return null
    try {
      const { result } = await projection.encryption.decryptStringAsync(Buffer.from(sealedEvent, 'base64'))
      const current = await pairing.read()
      if (signal.aborted || !current?.enabled || !current.groupChatEnabled || !current.userId || (!scheduled && current.groupReplyMode === 'record_only')) return null
      const message = parseImReceivedMessage({ platform: 'feishu', ownerId: 'desktop', botId: current.appId }, JSON.parse(result).event)
      const { chatType, chatId } = message.scope
      if (chatType !== 'group' || !chatId || desktopImEventKey(message) !== eventKey
        || groupConnectionId(current.appId, chatId, current.userId) !== connectionId
        || (!scheduled && !message.botMentioned && current.groupReplyMode !== 'reply_all')) return null
      return { current, message }
    } catch { return null }
  }
  return {
    ...supervisor,
    async readScheduledGroup(params: Record<string, unknown>, signal: AbortSignal) {
      const result = await readAuthorizedGroupMessage(params, signal, true)
      if (!result) return null
      const { current, message } = result
      return { platform: 'feishu', chatType: 'group', botId: current.appId,
        boundUserId: current.userId, recipient: message.scope.chatId }
    },
    async authorizeGroupTool(params: Record<string, unknown>, signal: AbortSignal) {
      const authorized = await readAuthorizedGroupMessage(params, signal)
      if (!authorized || typeof params.name !== 'string') return false
      const name = params.name
      return desktopImGroupToolAllowed('feishu', authorized.message.scope.platformUserId === authorized.current.userId, authorized.current.groupAllowedTools, name) && !signal.aborted
    },
    async readGroupMemoryContext(params: Record<string, unknown>, signal: AbortSignal) {
      const authorized = await readAuthorizedGroupMessage(params, signal)
      if (!authorized || typeof params.ownerId !== 'string' || !params.ownerId) return null
      const { current, message } = authorized
      const actor = resolveImActor({ ownerId: params.ownerId, botId: current.appId, platform: 'feishu',
        platformUserId: message.scope.platformUserId, chatType: 'group', chatId: message.scope.chatId,
        botMentioned: message.botMentioned, mentionsOtherBot: false,
        speakers: [{ platformUserId: message.scope.platformUserId }],
      }, scope => ({ role: scope.platformUserId === current.userId ? 'owner' : 'member', allowedToolNames: [] }))
      return { actor, ownerPlatformUserId: current.userId, groupMemoryEnabled: current.groupMemoryEnabled,
        groupOwnerMemoryEnabled: current.groupOwnerMemoryEnabled, memberMemoryEnabled: current.memberMemoryEnabled }
    },
  }
}
