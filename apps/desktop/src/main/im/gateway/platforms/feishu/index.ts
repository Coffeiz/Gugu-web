import { redactToolError } from '@gugu/core/agent'
import { createDesktopImChartRenderer, createDesktopImProjectionReceipts } from '../../delivery/projection.js'
import type { IpcHost } from '../../../../ipc/types.js'
import type { safeStorage } from 'electron'
import { DesktopError } from '../../../../core-host.js'
import { transcribeDesktopImFile, type DesktopImVoice } from '../../inbound/voice.js'
import { createHash } from 'node:crypto'
import { FeishuMediaIngressError, parseFeishuEvent, processFeishuMedia, readFeishuQuote } from '@gugu/gateway/feishu'
import { createGatewaySupervisor, readImReceivedMessage } from '@gugu/gateway'
import { createPersistentFeishuProjection, createFeishuClient, createFeishuConnection, createFeishuSender, createFeishuWsNetwork } from '@gugu/gateway/feishu'
import type { createDesktopFeishuPairing } from '../../../connect/platforms/feishu/index.js'
import type { createDesktopImCallback } from '../../interactions/callback.js'
import type { createDesktopImDispatch } from '../../delivery/dispatch.js'
import { MAX_DESKTOP_ATTACHMENT_BYTES } from '../../../../agent/attachments.js'
import type { DesktopImFile, createDesktopImInbox } from '../../inbound/inbox.js'

type Transport = NonNullable<Parameters<typeof createFeishuClient>[0]['transport']>
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function createDesktopFeishuGateway(pairing: Pick<ReturnType<typeof createDesktopFeishuPairing>, 'read'>,
  admit: ReturnType<typeof createDesktopImInbox>, dispatch: ReturnType<typeof createDesktopImDispatch>,
  transport: () => Transport, connect = createFeishuConnection, callback?: ReturnType<typeof createDesktopImCallback>, voice?: DesktopImVoice, projection?: { host: IpcHost; encryption: Pick<typeof safeStorage, 'encryptStringAsync' | 'decryptStringAsync'> }) {
  return createGatewaySupervisor({
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
      async function authorize() {
        if (active.aborted) return false
        const current = await pairing.read()
        return !active.aborted && current?.enabled === true && current.revision === bot.revision
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
              || parsed.payload.chat_type !== 'c2c' || parsed.payload.platform_user_id !== bot.userId
              || (!parsed.payload.text.trim() && !parsed.mediaItems.length) || !await authorize()) return
            const mediaSignal = AbortSignal.any([active, messageSignal, AbortSignal.timeout(60_000)])
            const quote = await readFeishuQuote(parsed, client, botOpenId, mediaSignal, authorize)
            if (!await authorize()) return
            mediaSignal.throwIfAborted()
            const event = readImReceivedMessage(connection, { ...parsed.payload, ...quote })
            if (!parsed.mediaItems.length) {
              await admit(connectionId, event, parsed.payload.chat_id)
              return
            }
            const files: DesktopImFile[] = []
            try {
              await processFeishuMedia(parsed.mediaItems, client, {
                maxBytes: MAX_DESKTOP_ATTACHMENT_BYTES, maxFiles: 16, signal: mediaSignal, authorize,
              }, async file => { files.push(await transcribeDesktopImFile(file, voice, mediaSignal, authorize)) })
              if (!await authorize()) return
              try {
                await admit(connectionId, event, parsed.payload.chat_id, { files, authorize })
              } catch (error) {
                if (!(error instanceof DesktopError && error.code === 'invalid_request')) throw error
                throw new FeishuMediaIngressError('feishu_media_stage')
              }
            } catch (error) {
              if (!(error instanceof FeishuMediaIngressError) || active.aborted || messageSignal.aborted) throw error
              const signal = AbortSignal.any([active, messageSignal, AbortSignal.timeout(5_000)])
              if (await authorize()) await sender.text(bot.userId, error.notice, signal, authorize)
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
        const delivery = dispatch({ connection, connectionId, userId: bot.userId, signal: active, authorize, media: { platform: 'feishu', sender },
          ...(projection ? { async createStream(target) {
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
                    ? { chatType: 'p2p', includeDetails: false, sanitize: redactToolError } : undefined,
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
          await delivery
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
}
