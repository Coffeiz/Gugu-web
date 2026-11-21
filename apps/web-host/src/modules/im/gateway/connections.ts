import { createTelegramAdapter, type createTelegramSender } from '@gugu/gateway/telegram'
import type { ProviderTransport } from '@gugu/core/providers'
import type { AddressResolver } from '@gugu/core/providers/node'
import { FeishuMediaIngressError, parseFeishuEvent } from '@gugu/gateway/feishu'
import { parseQqMessage, type ParsedQqMessage } from '@gugu/gateway/qq'
import type { RedisCommandClient } from '../../../workers/redis-stream-queue.js'
import type { TrustedGatewayBot } from './bot-config.js'
import { createNodeImInbox, type NodeImBotBinding } from './inbound/inbox.js'
import { createImInboundEnvelope } from './inbound/envelope.js'
import { createTelegramInbox } from './platforms/telegram/inbox.js'
import { createFeishuClient } from '@gugu/gateway/feishu'
import { createFeishuConnection, type FeishuConnectionOptions } from '@gugu/gateway/feishu'
import { createFeishuSender } from '@gugu/gateway/feishu'
import { createFeishuStreamingSender } from './platforms/feishu/streaming.js'
import { createQqClient } from '@gugu/gateway/qq'
import { createQqConnection, type QqSocket } from '@gugu/gateway/qq'
import { createQqSender } from '@gugu/gateway/qq'
import { createQqMediaUploader, QqMediaIngressError } from '@gugu/gateway/qq'
import { createQqReplySequences } from './platforms/qq/sequences.js'
import { createILinkClient } from '@gugu/gateway/wechat'
import { createWechatMedia } from '@gugu/gateway/wechat'
import { WECHAT_MISSING_VOICE_NOTICE, createWechatSender } from '@gugu/gateway/wechat'
import { connectWechatPolling } from '@gugu/gateway/wechat'
import { createPlatformMedia, type PlatformAttachmentStore } from './media/platform.js'
import { createImInboundPreflight, type ImPreflightPorts, type ImPreflightScope, GatewayConnectionCleanupError, parseGatewayInteraction, readImConversationScope, readImReceivedMessage, type GatewayClock, type GatewayConnection } from '@gugu/gateway'
import { ImGatewayAdmissionError, type ImGatewayAdmissionPort } from './inbound/admission.js'
import { chooseImInstantReactionEmoji } from '@gugu/core/im/shortcut'

type Payload = Record<string, unknown>
type Scope = Omit<ImPreflightScope, 'eventId'>
type Controls = Omit<ImPreflightPorts, 'reply'>
export interface GatewayCallbackResult { consumed: boolean; accepted: boolean; response?: Payload }
export interface GatewayConnectionServices {
  controls: Controls
  admission: ImGatewayAdmissionPort
  attachments: PlatformAttachmentStore
  /** 可信scope+实际协议回调；必须复用统一交互消费并处理重复事件，不能只ACK。 */
  callback?(event: { binding: NodeImBotBinding; platform: TrustedGatewayBot['platform']; data: Payload }, signal: AbortSignal): Promise<GatewayCallbackResult>
  /** 仅QQ需要：完整scope引用索引、QFace补图和分离表情关联；null表示受控等待后续事件。 */
  prepareQq?(scope: Scope, parsed: ParsedQqMessage, signal: AbortSignal): Promise<ParsedQqMessage | null>
  /** QQ附件即时确认只读当前可信群策略；缺端口时不开放体验层额外出站。 */
  qqInstantAckPolicy?(scope:Scope,payload:Readonly<Payload>,signal:AbortSignal):Promise<{messageFormat:'compat'|'markdown'}|null>
  /** TG媒体下载前再次从可信Bot库复核配置并取得token，不能返回其他Bot凭据。 */
  telegramToken?(binding: { ownerId: string; botId: string }, signal?: AbortSignal): Promise<string | null>
}
export type GatewayPlatformSender =
  | { platform: 'feishu'; sender: ReturnType<typeof createFeishuSender>; streaming: ReturnType<typeof createFeishuStreamingSender>;
      /** 真实连接总会提供；旧独立sender端口未声明此能力，资源工厂不能据此伪造CardKit client。 */
      client?: ReturnType<typeof createFeishuClient> }
  | { platform: 'qq'; sender: ReturnType<typeof createQqSender>; mediaUpload: ReturnType<typeof createQqMediaUploader> }
  | { platform: 'wechat'; sender: ReturnType<typeof createWechatSender> }
  | { platform: 'telegram'; sender: ReturnType<typeof createTelegramSender> }
const object = (value: unknown): value is Payload => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = () => new Error('IM 平台连接装配未完成')
function sameRoute(a: Payload, b: Payload): boolean {
  return ['platform', 'owner_user_id', 'bot_id', 'channel_id', 'chat_type', 'chat_id', 'platform_user_id', 'message_id'].every(key => a[key] === b[key])
}
function trustedScope(spec: TrustedGatewayBot, payload: Payload): Scope {
  return readImConversationScope({ ownerId: spec.owner, botId: spec.id, platform: spec.platform }, payload)
}

/** Supervisor实际连接工厂：平台协议→Core预检→真实媒体暂存→密封→Node专属队列。 */
export function createPlatformConnections(options: {
  redis: RedisCommandClient
  secretKey: string
  services(spec: TrustedGatewayBot): GatewayConnectionServices | Promise<GatewayConnectionServices>
  sanitizeText(text: string): string
  now?(): number
  clock?: GatewayClock
  transport?(spec: TrustedGatewayBot, purpose: 'api' | 'discovery' | 'media'): ProviderTransport
  resolve?: AddressResolver
  feishuNetwork?(spec: TrustedGatewayBot): FeishuConnectionOptions['wsNetwork']
  createFeishuSdk?: FeishuConnectionOptions['createSdkClient']
  qqSocket?(url: string, signal: AbortSignal): Promise<QqSocket>
  report?(code: string, error?: unknown): void
}) {
  if (!options.secretKey || typeof options.services !== 'function' || typeof options.sanitizeText !== 'function') throw invalid()
  const envelope = createImInboundEnvelope(options.secretKey), inbox = createNodeImInbox(options.redis)
  const active = new Map<string, { ownerId: string; value: GatewayPlatformSender }>()
  const opening = new Set<string>()
  const blocked = new Set<string>()
  const now = options.now ?? Date.now
  let accepting = true
  function assertAccepting() { if (!accepting) throw invalid() }
  async function connect(spec: TrustedGatewayBot, signal: AbortSignal): Promise<GatewayConnection> {
    if(spec&&blocked.has(spec.key))throw new GatewayConnectionCleanupError()
    if (!spec || !['feishu', 'qq', 'wechat', 'telegram'].includes(spec.platform) || !/^[1-9]\d*$/u.test(spec.id) ||
      spec.key !== `${spec.platform}:${spec.id}` || active.has(spec.key) || blocked.has(spec.key) || !spec.owner || !spec.credentials?.appSecret || typeof spec.credentials.appId !== 'string') throw invalid()
    const binding: NodeImBotBinding = Object.freeze({ platform: spec.platform, botId: spec.id, ownerId: spec.owner })
    const services = await options.services(spec)
    if (!services?.admission || ['begin', 'finish', 'markUnknown'].some(name => typeof services.admission[name as keyof ImGatewayAdmissionPort] !== 'function')) throw invalid()
    for (const name of ['authorize', 'inspectSecret', 'applySecret', 'bindQqOwnerIfUnbound', 'consumeBinding', 'consumeTextChoice', 'decideShortcut', 'cancel'] as const)
      if (typeof services?.controls?.[name] !== 'function') throw invalid()
    if (spec.platform !== 'wechat' && typeof services.callback !== 'function' || spec.platform === 'qq' && typeof services.prepareQq !== 'function' ||
      spec.platform === 'telegram' && typeof services.telegramToken !== 'function') throw invalid()
    const media = createPlatformMedia({ storage: services.attachments, transport: options.transport?.(spec, 'media'), resolve: options.resolve })
    const cleanup: Array<() => unknown | Promise<unknown>> = [() => media.close()]
    let connection: GatewayConnection | undefined, sender!: GatewayPlatformSender, stopped: Promise<void> | undefined
    let text!: (payload: Payload, value: string, quote: boolean, signal: AbortSignal, authorize: () => Promise<boolean>) => Promise<void>
    const preflight = async (payload: Payload, hasPendingMedia: boolean, signal: AbortSignal, mediaIds: readonly string[] = [],
      afterFreshAdmission?: (authorize: () => Promise<boolean>) => Promise<void>, captureFeedback?: (authorize: () => Promise<boolean>) => void) => {
      assertAccepting()
      const event = readImReceivedMessage(binding, payload)
      const scope = { ...event.scope, eventId: event.eventId }
      let token: string | undefined
      try {
        signal.throwIfAborted()
        const receipt = await services.admission.begin({ scope, text: event.text, hasPendingMedia,
          quotedText: event.quotedText, mediaIds })
        if (!receipt || !['first', 'admitted', 'consumed'].includes(receipt.status) || typeof receipt.receivedAt !== 'string'
          || !receipt.receivedAt || receipt.receivedAt.length > 128 || /[\r\n\0]/u.test(receipt.receivedAt)
          || !/^[a-f0-9]{64}$/u.test(receipt.controlEventId)) throw new ImGatewayAdmissionError('unavailable')
        const admittedScope = Object.freeze({ ...scope, eventId: receipt.controlEventId, admissionCutoff: receipt.receivedAt })
        captureFeedback?.(() => services.controls.authorize(admittedScope, signal))
        if (receipt.status === 'admitted') return 'enqueue' as const
        if (receipt.status === 'consumed') return 'consumed' as const
        if (receipt.status !== 'first') throw new ImGatewayAdmissionError('unavailable')
        if (typeof receipt.token !== 'string' || !receipt.token || receipt.token.length > 128) throw new ImGatewayAdmissionError('unavailable')
        token = receipt.token
        const run = createImInboundPreflight({ ...services.controls, reply: (currentScope, value, reply) => text(payload, value, reply.quote, reply.signal,
          () => services.controls.authorize(currentScope, reply.signal)) })
        // cutoff只来自可信PG准入收据，绝不从平台payload读取；保留PG微秒精度。
        const result = await run({ scope: admittedScope, text: event.text, hasPendingMedia,
          botMentioned: event.botMentioned,
          telegramCommand: typeof payload.telegram_command === 'string' ? payload.telegram_command : null }, signal)
        await services.admission.finish(scope, receipt.token, result)
        // 准入已永久完成，重投不再触发表情；体验反馈失败不得吞掉原消息或回退重跑控制。
        if (result === 'enqueue' && afterFreshAdmission) {
          try { await afterFreshAdmission(() => services.controls.authorize(admittedScope, signal)) }
          catch { /* 固定平台sender已处理异常；非关键反馈不改变准入结果。 */ }
        }
        return result
      } catch (error) {
        if (token) try { await services.admission.markUnknown(scope, token) } catch { /* pending同样阻止重放，健康端口可观察。 */ }
        const failure = error instanceof ImGatewayAdmissionError ? error : new ImGatewayAdmissionError('unknown')
        options.report?.(failure.code === 'pending' ? 'admission-pending' : failure.code === 'unknown' ? 'admission-unknown' : 'admission-unavailable')
        throw failure
      }
    }
    const enqueue = async (payload: Payload, signal: AbortSignal) => {
      signal.throwIfAborted(); trustedScope(spec, payload)
      if (!Array.isArray(payload.attachments) || payload.attachments.some(id => typeof id !== 'string' || !id)) throw invalid()
      await inbox.enqueue(binding, envelope.sealAdmitted(binding, payload))
    }
    async function finish(): Promise<void> {
      if (stopped) return stopped
      stopped = (async () => {
        active.delete(spec.key)
        let failed = false
        try { await connection?.stop() } catch { failed = true }
        for (const close of cleanup.reverse()) try { await close() } catch { failed = true }
        signal.removeEventListener('abort', abort)
        if (failed) { blocked.add(spec.key); throw new GatewayConnectionCleanupError() }
      })()
      return stopped
    }
    const abort = () => { void finish().catch(error => options.report?.(`${spec.platform}-cleanup-failed`, error)) }
    try {
      signal.throwIfAborted()
      if (spec.platform === 'telegram') {
        const { api, sender: out, connect } = createTelegramAdapter({ token: spec.credentials.appSecret, transport: options.transport?.(spec, 'api') })
        sender = { platform: 'telegram', sender: out }
        text = async (p, value, quote, signal, authorize) => { if (typeof authorize !== 'function') throw invalid()
          const result = await out.text({ chatId: String(p.chat_id || p.platform_user_id), chatType: p.chat_type as Scope['chatType'],
          ...(quote ? { replyToMessageId: String(p.message_id) } : {}) }, value, { signal, authorize }); if (result.outcome !== 'accepted') throw invalid() }
        // 长轮询逐消息串行；仅保存当前事件路由和可信收据guard，不保存正文或平台媒体材料。
        let mediaFeedback: { route: Payload; authorize(): Promise<boolean> } | undefined
        connection = await connect({ botId: spec.id, ownerId: spec.owner,
          inbox: createTelegramInbox(options.redis, spec.id, spec.owner, options.secretKey), signal,
          sleep: options.clock ? (ms, signal) => options.clock!.sleep(ms, signal) : undefined,
          preflight: (p, signal) => { mediaFeedback = undefined
            return preflight(p, p.attachments.length > 0 || p.quoted_attachments.length > 0, signal,
              [...p.attachments, ...p.quoted_attachments].map((item, index) => `${index}:${String(item.file_id)}`), undefined, authorize => {
                mediaFeedback = { route: Object.fromEntries(['platform', 'owner_user_id', 'bot_id', 'channel_id', 'chat_type', 'chat_id', 'platform_user_id', 'message_id'].map(key => [key, p[key]])), authorize }
              }) },
          materialize: (p, signal) => {
            const feedback = mediaFeedback; mediaFeedback = undefined
            if (!feedback || !sameRoute(feedback.route, p)) throw invalid()
            return media.telegram(trustedScope(spec, p), p, api, async (binding, signal) => {
              const token = await services.telegramToken!(binding, signal)
              return token === spec.credentials.appSecret ? token : null
            }, signal, async value => {
              try { await text(p, value, true, signal, feedback.authorize) }
              catch (error) { signal.throwIfAborted(); options.report?.('telegram-media-notice-failed', error) }
            })
          },
          callback: async (data, signal) => {
            assertAccepting()
            const result = await services.callback!({ binding, platform: 'telegram', data }, signal)
            if (!result.consumed) return false
            if (typeof data.id !== 'string' || !data.id) throw invalid()
            await api.call(spec.credentials.appSecret, 'answerCallbackQuery', { payload: { callback_query_id: data.id, text: result.accepted ? '已收到选择' : '交互已失效', show_alert: !result.accepted }, signal })
            if(result.accepted){
              try{
                const message=object(data.message)?data.message:{},chat=object(message.chat)?message.chat:{}
                if(!/^-?[1-9]\d*$/u.test(String(chat.id))||!Number.isSafeInteger(Number(chat.id))||!Number.isSafeInteger(message.message_id)||Number(message.message_id)<1)throw invalid()
                await api.call(spec.credentials.appSecret,'editMessageReplyMarkup',{payload:{chat_id:chat.id,message_id:message.message_id,reply_markup:{inline_keyboard:[]}},signal})
              }catch{
                // 已提交的业务消费不因键盘清理失败回滚，也不让poller重做业务。
                try{options.report?.('callback-cleanup-pending')}catch{/* 固定诊断失败不改变消费事实。 */}
              }
            }
            return true
          }, report: (event, error) => options.report?.(`telegram-${event}`, error) })
      } else if (spec.platform === 'wechat') {
        const client = createILinkClient({ botToken: spec.credentials.appSecret, baseUrl: spec.credentials.appId, transport: options.transport?.(spec, 'api') })
        const wxMedia = createWechatMedia({ client, transport: options.transport?.(spec, 'media') }); cleanup.push(() => wxMedia.close())
        const out = createWechatSender({ client, media: wxMedia }); sender = { platform: 'wechat', sender: out }
        cleanup.push(() => out.close())
        text = async (p, value, _quote, signal, authorize) => { if (typeof authorize !== 'function') throw invalid()
          if ((await out.text({ userId: String(p.platform_user_id), contextToken: String(p.context_token || '') }, value, signal, authorize)).outcome !== 'accepted') throw invalid() }
        connection = await connectWechatPolling({ botId: spec.id, ownerId: spec.owner, api: client, signal,
          sleep: options.clock ? (ms, signal) => options.clock!.sleep(ms, signal) : undefined,
          preflight: async (p, hasMedia, signal, items, missingVoice) => {
            const result = await preflight(p, hasMedia, signal, items.map((item, index) => `${item.source}:${item.kind}:${index}`),
              missingVoice ? async authorize => {
                try { await text(p, WECHAT_MISSING_VOICE_NOTICE, false, signal, authorize) }
                catch (error) { signal.throwIfAborted(); options.report?.('wechat-voice-notice-failed', error) }
              } : undefined)
            return missingVoice ? 'consumed' : result
          },
          materialize: (items, p, signal) => media.wechat(trustedScope(spec, p), items, p, wxMedia, signal),
          enqueue: (p, signal) => enqueue(p, signal), report: (event, error) => options.report?.(`wechat-${event}`, error) })
      } else if (spec.platform === 'qq') {
        if (!options.qqSocket) throw invalid()
        const client = createQqClient({ appId: spec.credentials.appId, appSecret: spec.credentials.appSecret, sandbox: spec.sandbox,
          transport: options.transport?.(spec, 'api'), resolveGateway: options.resolve })
        cleanup.push(() => client.close())
        const out = createQqSender({ client, botId: spec.id, sequences: createQqReplySequences(options.redis, binding), sanitizeText: options.sanitizeText })
        const mediaUpload = createQqMediaUploader({ client, transport: options.transport?.(spec, 'media') })
        cleanup.push(() => mediaUpload.close())
        sender = { platform: 'qq', sender: out, mediaUpload }
        text = async (p, value, quote, signal, authorize) => { if (typeof authorize !== 'function') throw invalid()
          if ((await out.text({ id: String(p.chat_type === 'group' ? p.chat_id : p.platform_user_id),
          chatType: p.chat_type as Scope['chatType'], ...(quote ? { messageId: String(p.message_id) } : {}) }, value, signal, authorize)).outcome !== 'accepted') throw invalid() }
        const lastAck=new Map<string,number>()
        connection = createQqConnection({ getAccessToken: signal => client.getAccessToken(signal), getGateway: (_token, signal) => client.getGateway(signal),
          openSocket: options.qqSocket, clock: options.clock, report: (event, error) => options.report?.(`qq-${event}`, error),
          onEvent: async (kind, data, signal) => {
            assertAccepting()
            if (kind === 'INTERACTION_CREATE') {
              const { eventId } = parseGatewayInteraction('qq', data)
              // 平台回执只确认收件。按钮授权和一次性消费仍由宿主处理。
              const receipt = await out.ackInteraction(eventId, 0, signal)
              if (!receipt.acknowledged) options.report?.('qq-interaction-ack-failed')
              signal.throwIfAborted()
              const result = await services.callback!({ binding, platform: 'qq', data: { ...data } }, signal)
              if (!result.consumed) throw invalid()
              return
            }
            const parsed = parseQqMessage(kind, data, { botId: spec.id, ownerId: spec.owner })
            let freshAuthorize:(()=>Promise<boolean>)|undefined
            if (!parsed || await preflight({ ...parsed.payload, text: parsed.preflight.text }, parsed.mediaItems.length > 0 || parsed.payload.emoji_refs.length > 0, signal,
              parsed.mediaItems.map(item => `${item.source}:${item.sourcePlatformMessageId ?? parsed.payload.platform_message_id}:${item.attachmentIndex}`),async authorize=>{freshAuthorize=authorize}) === 'consumed') return
            const prepared = await services.prepareQq!(trustedScope(spec, parsed.payload), parsed, signal)
            if (!prepared) return
            if (!sameRoute(parsed.payload, prepared.payload)) throw invalid()
            const scope = trustedScope(spec, prepared.payload)
            const materialized = await media.qq(scope, prepared, signal).catch(async error => {
              signal.throwIfAborted()
              if (error instanceof QqMediaIngressError && freshAuthorize) {
                try {
                  if (await freshAuthorize()) await text(prepared.payload, error.notice, true, signal, freshAuthorize)
                } catch { /* 保留附件接入错误，通知失败不覆盖其诊断。 */ }
              }
              throw error
            })
            if(freshAuthorize&&Array.isArray(materialized.attachments)&&materialized.attachments.length&&services.qqInstantAckPolicy){
              const scope=trustedScope(spec,materialized),recipient=scope.chatId??scope.platformUserId,key=`${scope.chatType}:${recipient}`
              try{
                const policy=await services.qqInstantAckPolicy(scope,materialized,signal)
                const authorize=async()=>await freshAuthorize!()&&!!policy&&(await services.qqInstantAckPolicy!(scope,materialized,signal))?.messageFormat===policy.messageFormat
                if(now()-(lastAck.get(key)??-Infinity)>10000&&await authorize()){
                  lastAck.set(key,now())
                  await out.text({id:recipient,chatType:scope.chatType,messageFormat:policy!.messageFormat,messageId:String(materialized.platform_message_id??materialized.message_id)},'文件收到啦，让我看看~',signal,authorize)
                }
              }catch{/* 体验确认失败不吞掉已准入原消息。 */}
            }
            await enqueue(materialized, signal)
          } })
      } else if (spec.platform === 'feishu') {
        if (!options.feishuNetwork) throw invalid()
        const client = createFeishuClient({ appId: spec.credentials.appId, appSecret: spec.credentials.appSecret, transport: options.transport?.(spec, 'api') })
        cleanup.push(() => client.close())
        const out = createFeishuSender({ client }); sender = { platform: 'feishu', sender: out, client, streaming: createFeishuStreamingSender({ client, sender: out }) }
        const identity = await client.call('GET', '/open-apis/bot/v3/info', { signal })
        const bot = object(identity.data) && object(identity.data.bot) ? identity.data.bot : object(identity.bot) ? identity.bot : {}
        if (typeof bot.open_id !== 'string' || !bot.open_id) throw invalid()
        const botOpenId = bot.open_id
        text = async (p, value, _quote, signal, authorize) => { if (typeof authorize !== 'function') throw invalid()
          if ((await out.text(String(p.chat_type === 'group' ? p.chat_id : p.platform_user_id), value, signal, authorize)).outcome !== 'accepted') throw invalid() }
        const parse = (data: unknown, eventType: string) => parseFeishuEvent(object(data) && object(data.event) ? data
          : { header: { event_type: eventType, ...(object(data) ? { app_id: data.app_id, event_id: data.event_id, create_time: data.create_time } : {}) }, event: data },
        { botId: spec.id, ownerId: spec.owner, appId: spec.credentials.appId, botOpenId, nowMs: now() })
        connection = await createFeishuConnection({ appId: spec.credentials.appId, appSecret: spec.credentials.appSecret, signal,
          wsNetwork: options.feishuNetwork(spec), createSdkClient: options.createFeishuSdk, transport: options.transport?.(spec, 'discovery'),
          onMessage: async (data, signal) => { const parsed = parse(data, 'im.message.receive_v1'); if (!parsed || parsed.kind !== 'message') return
            let authorizeMediaNotice: (() => Promise<boolean>) | undefined
            if (await preflight({ ...parsed.payload, text: parsed.preflight.text }, parsed.mediaItems.length > 0 || Array.isArray(parsed.preflight.attachments) && parsed.preflight.attachments.length > 0, signal,
              parsed.mediaItems.map(item => `${item.messageId}:${item.resourceType}:${item.resourceKey}`), async authorize => {
                await out.react(String(parsed.payload.platform_message_id ?? parsed.payload.message_id),
                  chooseImInstantReactionEmoji(String(parsed.preflight.text ?? ''), parsed.mediaItems.length > 0 || Array.isArray(parsed.preflight.attachments) && parsed.preflight.attachments.length > 0), signal, authorize)
              }, authorize => { authorizeMediaNotice = authorize }) === 'consumed') return
            const materialized = await media.feishu(trustedScope(spec, parsed.payload), parsed, client, botOpenId, signal).catch(async error => {
              signal.throwIfAborted()
              if (error instanceof FeishuMediaIngressError && authorizeMediaNotice) {
                try { await text(parsed.payload, error.notice, false, signal, authorizeMediaNotice) }
                catch { /* 保留附件接入原错误。 */ }
              }
              throw error
            })
            await enqueue(materialized, signal) },
          onCardAction: async (data, signal) => { assertAccepting(); const parsed = parse(data, 'card.action.trigger'); if (!parsed || parsed.kind !== 'card_action') throw invalid()
            const result = await services.callback!({ binding, platform: 'feishu', data: { ...parsed, raw: data } }, signal)
            if (!result.consumed) throw invalid()
            return result.response ?? { toast: { type: result.accepted ? 'info' : 'error', content: result.accepted ? '已收到选择' : '交互已失效' } } },
          report: (event, error) => {
            if (event !== 'reconnected' && event !== 'reconnecting') options.report?.(`feishu-${event}`, error)
          } })
      } else throw invalid()
      signal.throwIfAborted()
      active.set(spec.key, { ownerId: spec.owner, value: sender })
      signal.addEventListener('abort', abort, { once: true })
      const closed = connection.closed.then(async () => { await finish() }, async () => { await finish(); throw invalid() })
      void closed.catch(() => undefined)
      return { closed, stop: finish }
    } catch(error) {
      try{await finish()}catch{blocked.add(spec.key);throw new GatewayConnectionCleanupError()}
      if(error instanceof GatewayConnectionCleanupError){blocked.add(spec.key);throw error}
      throw invalid()
    }
  }
  return { pauseIngress() { accepting = false }, async connect(spec: TrustedGatewayBot, signal: AbortSignal): Promise<GatewayConnection> {
    if (!spec || opening.has(spec.key)) throw invalid()
    opening.add(spec.key)
    try { return await connect(spec, signal) } catch(error) { if(error instanceof GatewayConnectionCleanupError)throw error;throw invalid() } finally { opening.delete(spec.key) }
  }, sender(binding: NodeImBotBinding): GatewayPlatformSender | null {
    const entry = active.get(`${binding.platform}:${binding.botId}`)
    return entry?.ownerId === binding.ownerId ? entry.value : null
  } }
}
