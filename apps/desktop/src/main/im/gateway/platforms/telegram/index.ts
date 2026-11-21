import { redactToolError } from '@gugu/core/agent'
import { createDesktopImChartRenderer, createDesktopImProjectionReceipts } from '../../delivery/projection.js'
import { readDesktopAgentAttachmentContent } from '../../../../agent/attachments.js'
import type { IpcHost } from '../../../../ipc/types.js'
import { transcribeDesktopImFile, type DesktopImVoice } from '../../inbound/voice.js'
import { IM_BINDING_TTL_SECONDS, IM_BINDING_MAX_ATTEMPTS } from '@gugu/core/im/binding-code'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { createGatewaySupervisor, readImReceivedMessage } from '@gugu/gateway'
import { handleTelegramBinding, createTelegramAdapter, createPersistentTelegramProjection, processTelegramAttachments, telegramAttachmentReference, TelegramApiError, verifyTelegramBotIdentity } from '@gugu/gateway/telegram'
import { createNodeProviderTransport, desktopTransportOptions } from '@gugu/core/providers/node'
import type { DesktopTelegramMessage, DesktopTelegramSnapshot } from '@gugu/core/desktop'
import { createEncryptedDesktopStore } from '../../../../auth/store.js'
import { DesktopError } from '../../../../core-host.js'
import { createDesktopTelegramConfig, parseDesktopTelegramBot, validTelegramPrivateId, type DesktopTelegramBot, type DesktopTelegramEncryption } from '../../../connect/platforms/telegram/index.js'

import type { createDesktopImCallback } from '../../interactions/callback.js'
import type { DesktopImFile, createDesktopImInbox } from '../../inbound/inbox.js'
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
      async function authorize() {
        if (dispatchSignal.aborted) return false
        const latest = await store.read()
        return !dispatchSignal.aborted && latest?.enabled === true && latest.revision === bot.revision
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
          return bot.chatId && event.scope.chatType === 'c2c' && message.chat_id === bot.chatId && event.scope.platformUserId === bot.chatId
            && (event.text.trim() || admit && message.attachments.length)
            ? 'enqueue' : 'consumed'
        },
        async materialize(payload, signal) {
          mediaNotice = undefined
          if (current.cursor !== null && Number(payload.platform_event_id) <= current.cursor) return null
          if (!await authorize()) throw new DesktopError('cancelled', 'IM 连接已变更')
          const files: DesktopImFile[] = []
          if (admit && attachmentHost) {
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
              files.push(await transcribeDesktopImFile({ name: file.name, ext: file.ext, mime: file.mime, bytes: file.data, voice: file.kind === 'voice', sourceIndex: file.attachmentIndex }, voice, signal, authorize))
            }, authorize)
            if (result.failureNotice) mediaNotice = {
              updateId: Number(payload.platform_event_id), messageId: payload.message_id, text: result.failureNotice,
            }
          }
          signal.throwIfAborted()
          if (!await authorize()) throw new DesktopError('cancelled', 'IM 连接已变更')
          if (!payload.text.trim() && !files.length) return null
          const ready = { ...payload, attachments: [], quoted_attachments: [] }
          if (admit) {
            const event = readImReceivedMessage(connection, ready)
            if (files.length) await admit(connectionId(bot), event, undefined, { files, authorize, sourceMessageId: payload.attachment_source_message_id ?? undefined })
            else await admit(connectionId(bot), event)
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
            const messages = payload && typeof payload.text === 'string'
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
              try {
                if (!await authorize()) return
                await adapter.sender.text({ chatId: bot.chatId, chatType: 'c2c', replyToMessageId: notice.messageId },
                  notice.text, { signal, authorize })
              } catch { /* 提示失败不影响已完成的收件。 */ }
            }
          },
        },
      })
      if (!dispatch || !bot.chatId) return handle
      const delivery = dispatch({ connection, connectionId: connectionId(bot), userId: bot.chatId,
        signal: dispatchSignal, authorize, media: { platform: 'telegram', sender: adapter.sender },
        ...(attachmentHost ? { async createStream(target) {
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
      const closed = handle.closed.finally(() => controller.abort()).then(() => delivery)
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
    }
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
      if (previous && botId(previous) === botId(next)) next.chatId = previous.chatId
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
  }
}
