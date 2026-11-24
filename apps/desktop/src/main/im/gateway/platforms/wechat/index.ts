import { readImAddressedCommand } from '@gugu/gateway'
import { createHash } from 'node:crypto'
import { createGatewaySupervisor, readImReceivedMessage } from '@gugu/gateway'
import { connectWechatPolling, createILinkClient, createWechatTypingIndicator, createWechatTypingTicketCache, createWechatMedia, processWechatImages, createWechatSender, WECHAT_MISSING_VOICE_NOTICE } from '@gugu/gateway/wechat'
import { createEncryptedDesktopStore } from '../../../../auth/store.js'
import type { createDesktopWechatPairing } from '../../../connect/platforms/wechat/index.js'
import { MAX_DESKTOP_ATTACHMENT_BYTES } from '../../../../agent/attachments.js'
import type { DesktopImFile, createDesktopImInbox } from '../../inbound/inbox.js'
import type { IpcHost } from '../../../../ipc/types.js'
import { readDesktopImRunStatus, stopDesktopImRun, type createDesktopImDispatch } from '../../delivery/dispatch.js'

export function createDesktopWechatCursor(directory: string, encryption: Parameters<typeof createEncryptedDesktopStore>[2]) {
  return (connectionId: string) => createEncryptedDesktopStore(directory, `im-wechat-cursor-${connectionId}`, encryption, value => {
    if (typeof value !== 'string' || !value) throw new Error('微信轮询游标无效')
    return value
  })
}

/** 主动提醒复用当前绑定收到的微信会话凭据，仅存于本机加密存储。 */
export function createDesktopWechatReach(directory: string, encryption: Parameters<typeof createEncryptedDesktopStore>[2]) {
  return createEncryptedDesktopStore(directory, 'im-wechat-scheduled-reach', encryption, value => {
    if (!value || typeof value !== 'object' || !('revision' in value) || typeof value.revision !== 'string'
      || !('contextToken' in value) || typeof value.contextToken !== 'string' || !value.contextToken)
      throw new Error('微信主动投递信息无效')
    return { revision: value.revision, contextToken: value.contextToken }
  })
}

export function createDesktopWechatGateway(pairing: Pick<ReturnType<typeof createDesktopWechatPairing>, 'read'>,
  admit: ReturnType<typeof createDesktopImInbox>, dispatch: ReturnType<typeof createDesktopImDispatch>,
  transport: () => NonNullable<Parameters<typeof createILinkClient>[0]['transport']>, cursor: ReturnType<typeof createDesktopWechatCursor>,
  report?: (code: string, error?: unknown) => void, reach?: ReturnType<typeof createDesktopWechatReach>, host?: IpcHost) {
  return createGatewaySupervisor({
    async read() {
      const bot = await pairing.read()
      return bot?.enabled ? [{ ...bot, key: 'wechat' }] : []
    },
    async subscribe() { return { disconnected: new Promise<void>(() => {}), async close() {} } },
    async connect(bot, signal) {
      const connection = { platform: 'wechat', ownerId: 'desktop', botId: bot.botId } as const
      const connectionId = createHash('sha256').update(JSON.stringify([bot.botId, bot.userId])).digest('hex')
      const api = createILinkClient({ botToken: bot.token, baseUrl: bot.baseUrl, transport: transport() })
      const media = createWechatMedia({ client: api, transport: transport() })
      const sender = createWechatSender({ client: api, media })
      const controller = new AbortController()
      const active = AbortSignal.any([signal, controller.signal])
      async function authorize() {
        if (active.aborted) return false
        const latest = await pairing.read()
        return !active.aborted && latest?.enabled === true && latest.revision === bot.revision
      }
      // 在运行期间异步取票，微信入队和 Agent 启动无需等待。
      const tickets = createWechatTypingTicketCache(api, { fetchTimeoutMs: 2000 })
      let delivery: Promise<void> | undefined
      let recentContextToken: string | undefined
      const handle = await connectWechatPolling<DesktopImFile>({
        botId: bot.botId, ownerId: connection.ownerId, signal: active, cursor: cursor(connectionId),
        prefetchTypingTicket: false,
        api: { ...api, async close() {
          controller.abort()
          try { await delivery }
          finally { try { await sender.close() } finally { await Promise.all([tickets.close(), media.close(), api.close()]) } }
        } },
        report(event, error) { report?.(`wechat-${event}`, error) },
        async preflight(payload, pendingMedia, signal, _items, missingVoice) {
          if (payload.chat_type === 'c2c' && payload.platform_user_id !== bot.userId) {
            report?.('wechat-sender-unmatched')
            return 'consumed'
          }
          if (payload.chat_type !== 'c2c' || !payload.context_token || !await authorize()) return 'consumed'
          if (reach && recentContextToken !== payload.context_token) {
            const contextToken = payload.context_token
            try {
              await reach.write({ revision: bot.revision, contextToken })
              recentContextToken = contextToken
            } catch { report?.('wechat-schedule-reach-unavailable') }
          }
          if (host) {
            const event = readImReceivedMessage(connection, { ...payload })
            const { command } = readImAddressedCommand(event)
            if ((command?.name === 'stop' || command?.name === 'status') && !command.argument) {
              const text = await (command.name === 'stop' ? stopDesktopImRun : readDesktopImRunStatus)(host, event, connectionId)
              const deliveryId = createHash('sha256').update(JSON.stringify([connectionId, event.eventId, command.name])).digest('hex')
              await sender.text({ userId: bot.userId, contextToken: payload.context_token }, text, signal, authorize, deliveryId)
              return 'consumed'
            }
          }
          if (missingVoice) {
            const deliveryId = createHash('sha256').update(JSON.stringify([connectionId, payload.platform_event_id ?? payload.message_id, 'voice-notice'])).digest('hex')
            try {
              const receipt = await sender.text({ userId: bot.userId, contextToken: payload.context_token }, WECHAT_MISSING_VOICE_NOTICE, signal, authorize, deliveryId)
              if (receipt.outcome !== 'accepted' && !signal.aborted) report?.('wechat-voice-notice-failed')
            } catch (error) {
              signal.throwIfAborted()
              report?.('wechat-voice-notice-failed', error)
            }
            return 'consumed'
          }
          return pendingMedia || payload.text.trim() ? 'enqueue' : 'consumed'
        },
        async materialize(items, _payload, signal) {
          const files: DesktopImFile[] = []
          await processWechatImages(items, media, {
            maxBytes: MAX_DESKTOP_ATTACHMENT_BYTES, maxFiles: 16, signal, authorize,
          }, async file => { files.push(file) })
          return { files }
        },
        async enqueue(payload, _signal, files) {
          if (!await authorize()) return
          const event = readImReceivedMessage(connection, { ...payload })
          if (files.length) await admit(connectionId, event, payload.context_token, { files: [...files], authorize })
          else await admit(connectionId, event, payload.context_token)
        },
      })
      delivery = dispatch({ connection, connectionId, userId: bot.userId, signal: active, authorize, media: { platform: 'wechat', sender },
        startTyping(contextToken) {
          const typing = new AbortController()
          const signal = AbortSignal.any([active, typing.signal])
          let indicator: ReturnType<typeof createWechatTypingIndicator> | undefined
          const starting = (async () => {
            if (!await authorize() || signal.aborted) return
            const ticket = await tickets.get(bot.userId, contextToken, signal)
            if (signal.aborted) return
            if (ticket.status !== 'ready') {
              report?.('wechat-typing-ticket-unavailable')
              return
            }
            indicator = createWechatTypingIndicator({
              client: api, userId: bot.userId, ticket: ticket.ticket, authorize,
              stopTimeoutMs: 1000,
              report: code => report?.(`wechat-${code}`),
            })
            await indicator.start()
          })().catch(() => { if (!signal.aborted) report?.('wechat-typing-unavailable') })
          return async () => {
            typing.abort()
            await starting
            await indicator?.stop()
          }
        },
        async send(reply, contextToken) {
          if (!contextToken) return 'rejected'
          return (await sender.text({ userId: reply.recipient, contextToken }, reply.text, active, authorize, reply.deliveryId)).outcome
        },
      })
      const closed = handle.closed.finally(async () => { controller.abort(); await delivery })
      void closed.catch(() => {})
      return { closed, async stop() { controller.abort(); try { await handle.stop() } finally { await delivery } } }
    },
  })
}
