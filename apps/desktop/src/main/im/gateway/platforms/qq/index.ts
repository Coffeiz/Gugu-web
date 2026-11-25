import { classifyGatewayGroupMessage, type ImReceivedMessage } from '@gugu/gateway'
import { desktopImGroupToolAllowed } from '@gugu/core/agent/scenes/im'
import { transcribeDesktopImFile, type DesktopImVoice } from '../../inbound/voice.js'
import { resolveImActor } from '@gugu/core/im/access'
import { defaultUserBotGroupSettings, updateUserBotGroupTools, userBotGroupFileToolsAllowed } from '@gugu/core/im/user-bots'
import { createHash } from 'node:crypto'
import { desktopTransportOptions } from '@gugu/core/providers/node'
import { isExplicitImCancel, parseImControlCommand } from '@gugu/core/im/shortcut'
import { describeQqMedia, type QqMediaRequirement, createQqInboundPreparation, createQqFaceResolver, processQqMedia, handleQqBinding, parseQqMessage, QqMediaIngressError } from '@gugu/gateway/qq'
import { createImMediaBudget, createGatewaySupervisor, imSemanticText, readImReceivedInteraction, readImReceivedMessage, parseImReceivedMessage } from '@gugu/gateway'
import { createPersistentQqProjection, createQqChartPreparation, createQqMediaUploader, sendQqChart, createQqClient, createQqConnection, createQqSender, createQqSocketFactory } from '@gugu/gateway/qq'
import type { createDesktopQqPairing } from '../../../connect/platforms/qq/index.js'
import type { createDesktopImCallback } from '../../interactions/callback.js'
import { readDesktopImRunStatus, stopDesktopImRun, type createDesktopImDispatch } from '../../delivery/dispatch.js'
import { DesktopError } from '../../../../core-host.js'
import { MAX_DESKTOP_ATTACHMENT_BYTES, readDesktopAgentAttachment } from '../../../../agent/attachments.js'
import { desktopImEventKey, type createDesktopImInbox, type DesktopImFile } from '../../inbound/inbox.js'

import { createDesktopImProjectionReceipts } from '../../delivery/projection.js'

type ProjectionRuntime = { observeUpload?: Parameters<typeof createQqMediaUploader>[0]['observe']; dataDirectory?: string; references?: ReturnType<typeof import('./references.js').createDesktopQqReferences>; voice?: DesktopImVoice; host: Parameters<typeof createDesktopImProjectionReceipts>[0]; encryption: Parameters<typeof createDesktopImProjectionReceipts>[1] }
type Transport = NonNullable<Parameters<typeof createQqClient>[0]['transport']>

function groupConnectionId(botId: string, groupId: string, userId: string) {
  return createHash('sha256').update(JSON.stringify(['qq-group', botId, groupId, userId])).digest('hex')
}

export function createDesktopQqGateway(pairing: Pick<ReturnType<typeof createDesktopQqPairing>, 'read' | 'consumeBinding'>,
  admit: ReturnType<typeof createDesktopImInbox>, dispatch: ReturnType<typeof createDesktopImDispatch>,
  transport: () => Transport, connect = createQqConnection, callback?: ReturnType<typeof createDesktopImCallback>,
  report?: (code: string, error?: unknown) => void, runtime?: ProjectionRuntime) {
  const { resolve } = desktopTransportOptions()
  let ready = false
  const supervisor = createGatewaySupervisor({
    async read() {
      const bot = await pairing.read()
      return bot?.enabled ? [{ ...bot, key: 'qq' }] : []
    },
    async subscribe() { return { disconnected: new Promise<void>(() => {}), async close() {} } },
    async connect(bot, signal) {
      const connection = { platform: 'qq', ownerId: 'desktop', botId: bot.appId } as const
      const client = createQqClient({ appId: bot.appId, appSecret: bot.appSecret, sandbox: false, transport: transport(), resolveGateway: resolve })
      const sender = createQqSender({ botId: bot.appId, client, sanitizeText: text => text,
        sequences: {
          async nextPassive({ messageId }) {
            return runtime ? runtime.host.request<number>('im.qq.sequence', { botId: bot.appId, messageId }) : 1
          },
          async nextStream() {
            if (!runtime) throw new Error('本机 QQ 流式序号不可用')
            return runtime.host.request<number>('im.qq.sequence', { botId: bot.appId })
          },
        },
      })
      const mediaTransport = runtime ? transport() : undefined
      const faces = mediaTransport ? createQqFaceResolver({ transport: mediaTransport, report }) : undefined
      const uploader = mediaTransport ? createQqMediaUploader({ client, transport: mediaTransport, observe: runtime?.observeUpload }) : undefined
      const controller = new AbortController()
      const active = AbortSignal.any([signal, controller.signal])
      let delivery: Promise<void> | undefined
      const groupDeliveries = new Map<string, Promise<void>>()
      const groupMembers = new Map<string, Map<string, string | undefined>>()
      async function readActive() {
        if (active.aborted) return null
        const current = await pairing.read()
        return !active.aborted && current?.enabled && current.revision === bot.revision ? current : null
      }
      const scopeFor = (userId: string) => createHash('sha256').update(JSON.stringify([bot.appId, userId])).digest('hex')
      const prepare = runtime?.references && faces ? createQqInboundPreparation({
        references: runtime.references, appendAssets: faces.appendAssets,
        authorize: async (scope, signal) => {
          if (signal.aborted) return false
          const current = await readActive()
          return scope.chatType === 'group'
            ? current?.groupChatEnabled === true && !!current.userId
            : current?.userId === scope.platformUserId
        },
      }) : undefined
      function startDispatch(userId: string) {
        const connectionId = scopeFor(userId)
        const authorize = async () => (await readActive())?.userId === userId
        const referenceScope = { ...connection, chatType: 'c2c', chatId: null, platformUserId: userId } as const
        async function rememberReply({ platformMessageIds, text }: { platformMessageIds: readonly string[]; text: string }) {
          const references = runtime?.references
          if (!references || !text.trim()) return
          try {
            for (const id of new Set(platformMessageIds)) {
              if (!await authorize()) return
              await references.remember(referenceScope, id, {
                content: Array.from(text).slice(0, 200).join(''), sender_id: bot.appId, sender_is_bot: true,
              }, active)
            }
          } catch (error) {
            if (!active.aborted) report?.('qq_reference_write', error)
          }
        }
        delivery ??= dispatch({ connection, connectionId, userId, signal: active, authorize, ...(uploader ? { media: { platform: 'qq' as const, sender, mediaUpload: uploader } } : {}),
          ...(callback ? { async sendPrompt(prompt: Parameters<typeof sender.keyboard>[2], recipient: string) {
            const receipt = await sender.keyboard({ id: recipient, chatType: 'c2c' },
              [prompt.title || '请确认操作', prompt.body].filter(Boolean).join('\n'), prompt, active, authorize)
            return receipt.outcome === 'accepted' && receipt.platformMessageIds.length === 1 ? receipt.platformMessageIds[0]! : null
          } } : {}),
          ...(runtime && uploader ? { async createStream(target) {
            const receipts = createDesktopImProjectionReceipts(runtime.host, runtime.encryption,
              { platform: 'qq', connectionId, eventKey: target.eventKey, runId: target.runId })
            const checkpoint = await receipts.projection.read()
            const current = await readActive()
            if (!checkpoint.version && (checkpoint.plain || current?.privateMessageFormat !== 'markdown' || !current.privateStreamingEnabled)) return
            const recipient = { id: userId, chatType: 'c2c', messageFormat: 'markdown', messageId: target.messageId } as const
            const charts = createQqChartPreparation(authorize, async (request, signal) => {
              const [chart] = request.charts
              if (!chart || signal?.aborted) return []
              const encoded = await runtime.host.request<string | null>('im.chart.render', chart)
              return [encoded && !signal?.aborted ? Buffer.from(encoded, 'base64') : null]
            }, png => sendQqChart({ png, target: recipient, uploader, sender, authorize, signal: active }))
            let stream: ReturnType<typeof createPersistentQqProjection> | undefined
            return {
              async project(event) {
                if (event.identity.runId !== target.runId || event.identity.sessionId !== String(target.sessionId))
                  throw new Error('本机 QQ 流式运行身份不匹配')
                stream ??= createPersistentQqProjection({
                  identity: event.identity, receipts, sender, authorize, policyVersion: 'desktop-qq-v1',
                  target: recipient, charts, observeAcceptedText: rememberReply,
                  ...(target.referenceMessageId && target.referenceMessageId !== target.messageId
                    ? { legacyMessageId: target.referenceMessageId } : {}),
                })
                const result = await stream.project({ identity: event.identity, deliveryId: event.id, event })
                return typeof result === 'string' ? result : result.outcome
              },
              async close() { if (stream) await stream.close?.(); else await charts.close?.() },
            }
          } } : {}),
          async sendActiveNotice(reply) {
            const current = await readActive()
            if (current?.userId !== userId || reply.recipient !== userId) return 'rejected'
            return (await sender.text({ id: userId, chatType: 'c2c', messageFormat: current.privateMessageFormat },
              reply.text, active, authorize)).outcome
          },
          async send(reply) {
            const current = await readActive()
            if (!reply.originalMessageId || current?.userId !== userId) return 'rejected'
            const receipt = await sender.text({ id: reply.recipient, chatType: 'c2c', messageId: reply.originalMessageId,
              messageFormat: current.privateMessageFormat },
              reply.text, active, authorize)
            if (receipt.outcome === 'accepted') await rememberReply({ platformMessageIds: receipt.platformMessageIds, text: sender.prepareText(reply.text) })
            return receipt.outcome
          },
        })
        return connectionId
      }
      async function authorizeGroup(userId: string) {
        const current = await readActive()
        return current?.groupChatEnabled === true && current.userId === userId
      }
      function startGroupDispatch(groupId: string, userId: string) {
        const connectionId = groupConnectionId(bot.appId, groupId, userId)
        const authorize = () => authorizeGroup(userId)
        const authorizeMessage = async (message: ImReceivedMessage) => {
          const current = await readActive()
          return current?.groupChatEnabled === true && current.userId === userId
            && current.groupReplyMode !== 'record_only' && (message.botMentioned || message.qqAtEventOnly || current.groupReplyMode === 'reply_all')
        }
        const authorizeFile = async (message: ImReceivedMessage) => {
          const current = await readActive()
          return current?.groupChatEnabled === true && userBotGroupFileToolsAllowed(current) && current.userId === userId
            && current.groupReplyMode !== 'record_only' && (message.botMentioned || current.groupReplyMode === 'reply_all')
        }
        if (!groupDeliveries.has(connectionId)) {
          const work = dispatch({ connection, connectionId, signal: active, authorize,
            group: { id: groupId, ownerPlatformUserId: userId, authorizeMessage, authorizeFile },
            ...(uploader ? { media: { platform: 'qq' as const, sender, mediaUpload: uploader } } : {}),
            async sendOwnerPrivate(text) {
              const current = await readActive()
              if (current?.userId !== userId || !await authorize()) return 'rejected'
              return (await sender.text({ id: userId, chatType: 'c2c', messageFormat: current.privateMessageFormat }, text, active, authorize)).outcome
            },
            async send(reply, _replyContext, senderName) {
              if (!reply.originalMessageId || reply.recipient !== groupId || reply.scope.chatId !== groupId
                || reply.scope.botId !== bot.appId || !await authorize()) return 'rejected'
              const current = await readActive()
              if (!current) return 'rejected'
              const members = groupMembers.get(connectionId)
              const ambiguous = senderName && members && [...members].some(([id, name]) =>
                id !== reply.scope.platformUserId && name === senderName)
              return (await sender.text({ id: groupId, chatType: 'group', messageId: reply.originalMessageId,
                mentionUserId: reply.scope.platformUserId, mentionUserName: ambiguous ? undefined : senderName,
                knownMemberIds: [...(members?.keys() ?? [])],
                messageFormat: current.groupMessageFormat ?? 'compat' }, reply.text, active, authorize)).outcome
            },
          }).finally(() => { groupDeliveries.delete(connectionId) })
          groupDeliveries.set(connectionId, work)
          void work.catch(error => report?.('qq_group_dispatch', error))
        }
        return { connectionId, authorize }
      }
      let recovery: Promise<void> | undefined
      async function recoverGroups() {
        if (!runtime) return
        let after = ''
        while (!active.aborted) {
          const current = await readActive()
          if (!current?.groupChatEnabled || !current.userId) return
          const row = await runtime.host.request<{ connectionId: string; eventKey: string; sealedEvent: string } | null>(
            'im.inbox.pendingConnection', { platform: 'qq', after })
          if (!row || row.connectionId <= after) return
          after = row.connectionId
          try {
            const { result } = await runtime.encryption.decryptStringAsync(Buffer.from(row.sealedEvent, 'base64'))
            const message = parseImReceivedMessage(connection, JSON.parse(result).event)
            const scope = message.scope
            if (scope.chatType !== 'group' || !scope.chatId
              || desktopImEventKey(message) !== row.eventKey || groupConnectionId(bot.appId, scope.chatId, current.userId) !== row.connectionId) continue
            if (!await authorizeGroup(current.userId)) return
            startGroupDispatch(scope.chatId, current.userId)
          } catch (error) {
            if (!active.aborted) report?.('qq_group_recovery', error)
          }
        }
      }
      const handle = connect({
        getAccessToken: signal => client.getAccessToken(signal),
        getGateway: (_token, signal) => client.getGateway(signal),
        openSocket: createQqSocketFactory({ allowDirect: true, resolve }),
        onReadyChange(connected) {
          ready = connected
          if (connected && !recovery)
            recovery = recoverGroups().catch(error => {
              if (!active.aborted) report?.('qq_group_recovery', error)
            }).finally(() => { recovery = undefined })
        },
        report: (event, error) => report?.(`qq-${event}`, error),
        async onEvent(kind, data, signal) {
          const eventReceivedMs = Date.now()
          const current = await readActive()
          if (!current || signal.aborted) return
          if (kind === 'INTERACTION_CREATE' && callback && current.userId) {
            const { action } = readImReceivedInteraction(connection, 'qq', { ...data })
            const userId = current.userId
            const authorize = async () => !signal.aborted && (await readActive())?.userId === userId
            if (!await authorize()) return
            await sender.ackInteraction(action.eventId, 0, signal)
            await callback(connection, scopeFor(userId), userId, { ...data }, authorize)
            return
          }
          const group = kind === 'GROUP_AT_MESSAGE_CREATE' || kind === 'GROUP_MESSAGE_CREATE'
          if (kind !== 'C2C_MESSAGE_CREATE' && !group) return
          let parsed = parseQqMessage(kind, data, { botId: bot.appId, ownerId: connection.ownerId })
          if (!parsed || (!parsed.mediaItems.length && !parsed.payload.text.trim() && !parsed.quoteRequest && !parsed.payload.quoted_text)) return
          const userId = parsed.payload.platform_user_id
          let event = readImReceivedMessage(connection, { ...parsed.payload, event_received_ms: eventReceivedMs })
          const mentioned = event.botMentioned || event.qqAtEventOnly === true
          const semantic = imSemanticText(event.text, mentioned)
          const slash = parseImControlCommand(semantic)
          const explicitStop = (!group || mentioned) && slash?.name === 'stop' && !slash.argument
          const explicitStatus = (!group || mentioned) && slash?.name === 'status' && !slash.argument
          const cancelControl = !parsed.mediaItems.length && !parsed.quoteRequest && !event.quotedText
            && (explicitStop || isExplicitImCancel(semantic))
          if (group && (!current.groupChatEnabled || !current.userId || current.bindingEventId === event.eventId)) return
          const groupFacts = { platform: 'qq', chatType: 'group', chatId: event.scope.chatId,
            groupMentioned: event.botMentioned || event.qqAtEventOnly === true,
            mentionsOtherBot: parsed.payload.mentions_other_bot === true } as const
          const groupDisposition = (mode: typeof current.groupReplyMode) =>
            classifyGatewayGroupMessage(groupFacts, mode ?? defaultUserBotGroupSettings('qq').groupReplyMode, cancelControl)
          if (!current.userId) {
            if (parsed.mediaItems.length) return
            await handleQqBinding(parsed.payload.text, async code => {
              const bound = await pairing.consumeBinding({
                appId: bot.appId, revision: bot.revision, chatType: 'c2c', userId, eventId: event.eventId,
              }, code)
              if (bound) startDispatch(userId)
              return bound
            }, async text => {
              const authorize = async () => (await readActive())?.userId === userId
              if (!await authorize()) return
              await sender.text({ id: userId, chatType: 'c2c', messageId: event.eventId, messageFormat: 'compat' }, text, signal, authorize)
            })
            return
          }
          if ((!group && current.userId !== userId) || current.bindingEventId === event.eventId || signal.aborted) return
          const disposition = group ? groupDisposition(current.groupReplyMode) : 'reply'
          if (!disposition) return
          const recordOnly = disposition === 'passive'
          if (group && !event.scope.chatId) return
          const groupId = event.scope.chatId
          const authorize = async () => {
            if (signal.aborted) return false
            const latest = await readActive()
            return group ? latest?.userId === current.userId && latest.groupChatEnabled === true
              && groupDisposition(latest.groupReplyMode) === disposition : latest?.userId === userId
          }
          if (!await authorize()) return
          const connectionId = groupId
            ? recordOnly ? groupConnectionId(bot.appId, groupId, current.userId) : startGroupDispatch(groupId, current.userId).connectionId
            : startDispatch(userId)
          if (groupId) {
            const members = groupMembers.get(connectionId) ?? new Map<string, string | undefined>()
            const name = event.platformUserName ?? members.get(userId)
            members.delete(userId)
            members.set(userId, name)
            if (members.size > 256) members.delete(members.keys().next().value!)
            groupMembers.delete(connectionId)
            groupMembers.set(connectionId, members)
            if (groupMembers.size > 128) groupMembers.delete(groupMembers.keys().next().value!)
          }
          if ((cancelControl || explicitStatus) && !recordOnly && runtime) {
            const owner = group ? current.userId : undefined
            let reply: string | null
            if (explicitStatus) reply = await readDesktopImRunStatus(runtime.host, event, connectionId, owner)
            else if (explicitStop) reply = await stopDesktopImRun(runtime.host, event, connectionId, owner)
            else {
              const result = await runtime.host.request<{ outcome: 'idle' | 'requested' | 'already_completed' | 'not_owner' }>('im.inbox.cancelRun', {
                platform: 'qq', connectionId, chatType: event.scope.chatType,
                platformUserId: event.scope.platformUserId,
                ...(group ? { ownerPlatformUserId: owner } : {}),
              })
              reply = result.outcome === 'requested' ? '好的，那这个先不继续啦～'
                : result.outcome === 'already_completed' ? '这个任务已经结束啦～'
                  : result.outcome === 'not_owner' ? '这个不是你发起的任务哦，咕咕还在忙～' : null
            }
            if (reply) {
              const latest = await readActive()
              if (latest && await authorize()) {
                try {
                  await sender.text({ id: groupId ?? userId, chatType: group ? 'group' : 'c2c',
                    messageId: event.platformMessageId ?? event.eventId,
                    messageFormat: group ? latest.groupMessageFormat ?? 'compat' : latest.privateMessageFormat },
                  reply, signal, authorize)
                } catch (error) { if (!signal.aborted) report?.('qq_cancel_reply', error) }
              }
              return
            }
          }
          if (prepare) {
            parsed = await prepare.prepare(event.scope, parsed, signal)
            if (!parsed) return
            event = readImReceivedMessage(connection, { ...parsed.payload, event_received_ms: eventReceivedMs })
          } else {
            await faces?.appendAssets(parsed, signal)
            event = readImReceivedMessage(connection, { ...parsed.payload, event_received_ms: eventReceivedMs })
          }
          if (!await authorize()) return
          if (!parsed.mediaItems.length) {
            if (recordOnly) {
              if (event.text.trim() || event.quotedText) await admit(connection, connectionId, event, undefined, { files: [], recordOnly, ownerPlatformUserId: current.userId, authorize })
            } else await admit(connection, connectionId, event)
            return
          }
          if (!mediaTransport) return
          const downloadSignal = AbortSignal.any([signal, active, AbortSignal.timeout(60_000)])
          try {
            const files: DesktopImFile[] = []
            let faceImage = false
            const sourceIndices = new Map<number, number>()
            const budget = createImMediaBudget(MAX_DESKTOP_ATTACHMENT_BYTES, 16)
            async function appendFile(media: QqMediaRequirement, file: DesktopImFile) {
              const prepared = await transcribeDesktopImFile(file, recordOnly ? undefined : runtime?.voice, downloadSignal, authorize)
              if (media.item.qface_generated === true) faceImage = true
              if (media.source === 'message' && media.attachmentIndex < 256)
                sourceIndices.set(media.attachmentIndex, files.length)
              files.push(prepared)
            }
            const processed = await processQqMedia(parsed.mediaItems, budget, downloadSignal, {
              transport: mediaTransport, resolve, authorize, file: appendFile,
              async quote(media, sourcePlatformMessageId) {
                if (!runtime?.references || !runtime.dataDirectory) return false
                const id = await runtime.references.attachment(event.scope, sourcePlatformMessageId, media.attachmentIndex, downloadSignal)
                if (!id) return false
                try {
                  const quoted = await readDesktopAgentAttachment(runtime.host, runtime.dataDirectory, id)
                  if (!budget.consume(quoted.data.byteLength)) throw new QqMediaIngressError('qq_media_size')
                  const metadata = describeQqMedia({ filename: quoted.name, content_type: quoted.mime }, quoted.data)
                  if (!metadata) return false
                  await appendFile(media, { ...metadata, bytes: quoted.data })
                  return true
                } catch (error) {
                  if (!(error instanceof DesktopError && error.code === 'not_found')) throw error
                  return false
                }
              },
            })
            if (!processed || !await authorize()) return
            if (!files.length && !event.text.trim() && !event.quotedText) return
            const incoming = parsed.splitFace.faceOnly && faceImage ? { ...event, text: '' }
              : !event.text.trim() && files.length > 0 && files.every(file => !file.transcript && !/^(?:image\/|text\/)/u.test(file.mime))
              ? { ...event, text: '[QQ 附件]' } : event
            try {
              await admit(connection, connectionId, incoming, undefined, { files, recordOnly, ownerPlatformUserId: recordOnly ? current.userId : undefined, authorize, async onAccepted(ids) {
                if (!sourceIndices.size || !runtime?.references || !await authorize()) return
                const items = Object.fromEntries([...sourceIndices].map(([index, position]) => [index, ids[position]!]))
                await runtime.references.rememberAttachments(event.scope, event.platformMessageId ?? event.eventId, items, active)
              } })
            } catch (error) {
              if (!(error instanceof DesktopError && error.code === 'invalid_request')) throw error
              throw new QqMediaIngressError('qq_media_stage')
            }
          } catch (error) {
            if (signal.aborted || active.aborted) return
            report?.(error instanceof QqMediaIngressError ? error.code : 'qq_media_stage', error)
            if (!(error instanceof QqMediaIngressError) || recordOnly) return
            const noticeSignal = AbortSignal.any([signal, active, AbortSignal.timeout(5_000)])
            const authorizeNotice = async () => {
              if (noticeSignal.aborted || !await authorize()) return false
              const latest = await readActive()
              return !group || latest?.groupReplyMode === current.groupReplyMode
            }
            try {
              if (!await authorizeNotice()) return
              const latest = await readActive()
              if (!latest) return
              await sender.text({ id: groupId ?? userId, chatType: group ? 'group' : 'c2c',
                messageId: event.platformMessageId ?? event.eventId,
                messageFormat: group ? latest.groupMessageFormat ?? 'compat' : latest.privateMessageFormat },
              error.notice, noticeSignal, authorizeNotice)
            } catch { /* 保留原附件失败诊断。 */ }
          }
        },
      })
      if (bot.userId) startDispatch(bot.userId)
      const closed = handle.closed.finally(async () => { controller.abort(); try { await recovery; await Promise.allSettled([delivery, ...groupDeliveries.values()]) } finally { prepare?.close(); await faces?.close(); await Promise.all([uploader?.close(), client.close()]) } })
      void closed.catch(() => {})
      return { closed, async stop() { controller.abort(); try { await handle.stop() } finally { await closed } } }
    },
  })
  async function readAuthorizedGroupMessage(params: Record<string, unknown>, signal: AbortSignal, scheduled = false) {
    const { connectionId, eventKey, sealedEvent } = params
    if (!runtime || signal.aborted || typeof connectionId !== 'string' || typeof eventKey !== 'string'
      || typeof sealedEvent !== 'string' || sealedEvent.length > 48_000) return null
    try {
      const { result } = await runtime.encryption.decryptStringAsync(Buffer.from(sealedEvent, 'base64'))
      const current = await pairing.read()
      if (signal.aborted || !current?.enabled || !current.groupChatEnabled || !current.userId
        || (!scheduled && current.groupReplyMode === 'record_only')) return null
      const message = parseImReceivedMessage({ platform: 'qq', ownerId: 'desktop', botId: current.appId }, JSON.parse(result).event)
      const { chatType, chatId } = message.scope
      if (chatType !== 'group' || !chatId || desktopImEventKey(message) !== eventKey
        || groupConnectionId(current.appId, chatId, current.userId) !== connectionId
        || (!scheduled && !message.botMentioned && !message.qqAtEventOnly && current.groupReplyMode !== 'reply_all')) return null
      return { current, message }
    } catch { return null }
  }

  return {
    ...supervisor,
    async readScheduledGroup(params: Record<string, unknown>, signal: AbortSignal) {
      const result = await readAuthorizedGroupMessage(params, signal, true)
      if (!result) return null
      const { current, message } = result
      return { platform: 'qq', chatType: 'group', botId: current.appId,
        boundUserId: current.userId, recipient: message.scope.chatId }
    },
    async authorizeGroupTool(params: Record<string, unknown>, signal: AbortSignal) {
      const { name } = params
      const authorized = await readAuthorizedGroupMessage(params, signal)
      if (!authorized || typeof name !== 'string') return false
      const { current } = authorized
      const tools = updateUserBotGroupTools([], {
        groupWebToolsEnabled: current.groupWebToolsEnabled,
        groupProviderSearchEnabled: current.groupProviderSearchEnabled,
        groupHistorySearchEnabled: current.groupHistorySearchEnabled,
      })
      return desktopImGroupToolAllowed('qq', authorized.message.scope.platformUserId === current.userId, tools, name) && !signal.aborted
    },
    async readGroupMemoryContext(params: Record<string, unknown>, signal: AbortSignal) {
      const authorized = await readAuthorizedGroupMessage(params, signal)
      if (!authorized || typeof params.ownerId !== 'string' || !params.ownerId) return null
      const { current, message } = authorized
      const ownerPlatformUserId = current.userId!
      const actor = resolveImActor({ ownerId: params.ownerId, botId: current.appId, platform: 'qq',
        platformUserId: message.scope.platformUserId, chatType: 'group', chatId: message.scope.chatId,
        botMentioned: message.botMentioned, mentionsOtherBot: false,
        speakers: [{ platformUserId: message.scope.platformUserId }],
      }, scope => ({ role: scope.platformUserId === ownerPlatformUserId ? 'owner' : 'member', allowedToolNames: [] }))
      return { actor, ownerPlatformUserId: current.userId, groupMemoryEnabled: current.groupMemoryEnabled !== false,
        groupOwnerMemoryEnabled: current.groupOwnerMemoryEnabled === true,
        memberMemoryEnabled: current.memberMemoryEnabled !== false }
    },
    health() {
      const health = supervisor.health()
      return { ...health, running: ready ? health.running : 0 }
    },
  }
}
