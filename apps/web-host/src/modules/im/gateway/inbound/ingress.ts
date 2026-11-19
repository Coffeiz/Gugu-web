import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { classifyImGroupInbound, imActorInputFromPayload, type ImActor, type ImBotAccess } from '@gugu/core/im/access'
import type { createImInboundPreflight } from '@gugu/core/im/inbound-preflight'
import type { RunIdentity } from '@gugu/core/agent'
import { enqueueAgentRunLocked } from '../../../agent/run/dispatch.js'
import { registerAgentRunStartupLocked } from '../../../agent/run/start.js'
import { createPostgresImAccess } from './access.js'
import { createPostgresImConversationStore, type ImConversationAttachments, type ImConversationAnchor, type ImConversationBatchItem } from '../agent/conversations.js'
import type { NodeImBotBinding } from './inbox.js'
import type { createPostgresImAttentionRuntime } from '../attention/runtime.js'
import { attentionSourceKind, parseImAttentionRecord, type ImAttentionRecord } from '@gugu/core/im/attention/directive'
import { createPostgresImPendingAskDispatcher } from '../interactions/dispatch.js'
import { pumpImPendingAsks, type createRedisImPendingAskStore, type ImPendingAskResume } from '../interactions/ask.js'
import type { ImVoiceRunProof } from '../attention/voice.js'
import type { createImRetiredInbound } from './retired.js'

type Payload = Record<string, unknown>
const inputOf = imActorInputFromPayload

/** 明确接入既有启动/持久调度；本模块不运行模型，也不把Redis ACK当业务提交。 */
export function createPostgresImIngress(options: {
  pool: Pick<Pool, 'connect' | 'query'>
  secretKey: string
  supportedPlatforms(): readonly string[] | Promise<readonly string[]>
  attachments: ImConversationAttachments
  preflight: ReturnType<typeof createImInboundPreflight>
  model: { accessVersion(identity: RunIdentity, actor: ImActor, bot: ImBotAccess, memoryEnabled: boolean): Promise<string> }
  memoryEnabled(ownerId: string): Promise<boolean>
  /** 正式群自动回复必须提供；旧组件调用可独立验证基础入站。 */
  attention?: ReturnType<typeof createPostgresImAttentionRuntime>
  pendingAsks?: ReturnType<typeof createRedisImPendingAskStore>
  bindVoiceCacheLocked?(client: PoolClient, proof: ImVoiceRunProof, signal?: AbortSignal): Promise<void>
  ownerSession?(client: PoolClient, binding: NodeImBotBinding, payload: Readonly<Payload>): Promise<number | null>
  beforeCreateSession?(client:PoolClient,ownerId:string):Promise<void>
  retired?:Pick<ReturnType<typeof createImRetiredInbound>,'seen'|'seenLocked'>
  notify(): Promise<void>
  conversationChanged?(ownerId: string, sessionId: number): Promise<void>
  observePassiveLocked?(client:PoolClient,ownerId:string,sessionId:number,messageIds:readonly string[]):Promise<void>
  observePassiveLocked?(client:PoolClient,ownerId:string,sessionId:number,messageIds:readonly string[]):Promise<void>
  diagnose(code: 'notify_pending'): void
}) {
  const accessFor = (query: Parameters<typeof createPostgresImAccess>[0]['query']) => createPostgresImAccess({ query, supportedPlatforms: options.supportedPlatforms })
  async function bindVoice(client: PoolClient, binding: NodeImBotBinding, payload: Readonly<Payload>, identity: RunIdentity,
    messageIds: readonly string[], signal?: AbortSignal) {
    if (!options.bindVoiceCacheLocked) return
    signal?.throwIfAborted()
    const input = inputOf(binding, payload), access = accessFor((sql, args) => client.query(sql, args)), snapshot = await access.snapshot(input)
    const actor = snapshot.actor(input)
    await options.bindVoiceCacheLocked(client, { identity, actor, payload, messageIds,
      scope: { ownerId: actor.ownerId, botId: actor.botId, platform: actor.platform, chatType: actor.chatType,
        chatId: actor.chatId, platformUserId: actor.platformUserId },
      async authorize(currentSignal) { currentSignal?.throwIfAborted(); return access.authorizeDelivery(actor, snapshot.bot) },
    }, signal)
  }
  async function classify(client: Pick<PoolClient, 'query'>, binding: NodeImBotBinding, payload: Readonly<Payload>) {
    const input = inputOf(binding, payload)
    if (input.chatType !== 'group') return 'reply' as const
    if (binding.platform === 'wechat') return 'control' as const
    const result = await client.query(`SELECT group_chat_enabled,feishu_group_chat_enabled,group_requires_at,group_read_enabled
      FROM user_bots WHERE user_id=$1 AND id=$2 AND platform=$3 AND enabled IS TRUE`, [binding.ownerId, binding.botId, binding.platform])
    const row = result.rows[0]
    if (row && binding.platform === 'feishu' && row.feishu_group_chat_enabled !== null && typeof row.feishu_group_chat_enabled !== 'boolean') throw new Error('IM 群回应配置无效')
    if (!row || (binding.platform === 'feishu' ? row.feishu_group_chat_enabled === false : row.group_chat_enabled !== true)) return 'control' as const
    if (typeof row.group_read_enabled !== 'boolean' || typeof row.group_requires_at !== 'boolean') throw new Error('IM 群回应配置无效')
    return classifyImGroupInbound({ ...input, groupMentioned: payload.group_mentioned === true },
      { readOnly: row.group_requires_at && row.group_read_enabled, requiresAt: row.group_requires_at }) ?? 'reply'
  }
  const store = createPostgresImConversationStore({ pool: options.pool, secretKey: options.secretKey, attachments: options.attachments,
    async authorize(client, binding, payload) {
      return !!await accessFor((sql, args) => client.query(sql, args)).readBot(inputOf(binding, payload as Payload))
    },
    classify, ownerSession: options.ownerSession, beforeCreate: options.beforeCreateSession,
    retired: options.retired?.seenLocked, afterCommit: options.conversationChanged, afterDispatch: bindVoice,afterPassive:options.observePassiveLocked,
  })
  async function preflight(binding: NodeImBotBinding, payload: Payload, eventId: string, signal: AbortSignal) {
    const input = inputOf(binding, payload)
    if (typeof payload.text !== 'string' || !eventId) throw new Error('IM 入站内容无效')
    signal.throwIfAborted()
    return options.preflight({ scope: { ...input, eventId }, text: payload.text, botMentioned: input.botMentioned,
      hasPendingMedia: Array.isArray(payload.attachments) && payload.attachments.length > 0,
      telegramCommand: typeof payload.telegram_command === 'string' ? payload.telegram_command : null }, signal)
  }
  async function enqueue(client: PoolClient, binding: NodeImBotBinding, payload: Payload, anchor: ImConversationAnchor,
    signal: AbortSignal, batch?: { batchKey: string; segmentKey: string; messageIds: number[] }, trustedAttention?: ImAttentionRecord) {
    signal.throwIfAborted()
    const input = inputOf(binding, payload), snapshot = await accessFor((sql, args) => client.query(sql, args)).snapshot(input)
    const actor = snapshot.actor(input), memoryEnabled = await options.memoryEnabled(binding.ownerId)
    if (typeof memoryEnabled !== 'boolean') throw new Error('IM 记忆配置无效')
    const identity = { ownerId: binding.ownerId, sessionId: String(anchor.sessionId), runId: randomUUID() }
    const attention = trustedAttention === undefined ? undefined : parseImAttentionRecord(trustedAttention)
    if (!await registerAgentRunStartupLocked(client, identity)) throw new Error('IM 运行启动登记冲突')
    const accessVersion = await options.model.accessVersion(identity, actor, snapshot.bot, memoryEnabled)
    await enqueueAgentRunLocked(client, options.secretKey, identity, { v: 3, source: 'im', origin: null,
      userMessageId: anchor.messageId, locale: null, accessVersion,
      im: { platform: binding.platform, botId: binding.botId, chatType: input.chatType, chatId: input.chatId,
        platformUserId: input.platformUserId, ...(batch ? { batch } : {}), ...(attention ? { attention } : {}) } }, 604800)
    signal.throwIfAborted()
    return identity.runId
  }
  async function notify() { try { await options.notify() } catch { options.diagnose('notify_pending') } }
  if (options.pendingAsks && !options.attention) throw new TypeError('延迟群回复必须装配正式注意力运行时')
  const pending = options.pendingAsks && options.attention ? createPostgresImPendingAskDispatcher({
    pool: options.pool, secretKey: options.secretKey, pending: options.pendingAsks, attention: options.attention,
    afterDispatch: bindVoice,
    supportedPlatforms: options.supportedPlatforms,
    enqueue: (client, input, signal) => enqueue(client, input.binding, input.payload, input.anchor, signal, undefined, input.attention),
    notify: options.notify, diagnose: () => options.diagnose('notify_pending'),
  }) : null
  async function prepareAdmitted(binding: NodeImBotBinding, payload: Payload, eventId: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    const input = inputOf(binding, payload)
    if (typeof payload.text !== 'string' || !eventId) throw new Error('IM 入站内容无效')
    const access = await accessFor((sql, args) => options.pool.query(sql, args)).snapshot(input)
    access.actor(input)
    if (await options.retired?.seen(binding,payload,signal)) return false
    const mode = await classify(options.pool, binding, payload)
    if (mode === 'control') return false
    const anchor = await store.persist(binding, payload, { eventId, mode: mode === 'passive' ? 'passive' : 'early' })
    signal.throwIfAborted()
    // receipt/startup/dispatch同事务提交后，恢复归调度Worker；平台重投只确认原事件。
    return mode === 'reply' && anchor?.recordedPassive !== true && !anchor?.runId
  }
  const ingress = {
    readRoute: store.readRoute,
    readRouteLocked: store.readRouteLocked,
    async verifyPendingAskRun(identity: RunIdentity, payload: Readonly<Payload>, signal: AbortSignal) {
      if (!pending) throw new Error('延迟群回复未装配')
      return pending.verifyRun(identity, payload, signal)
    },
    /** 仅供可信内部定时唤醒；普通平台事件没有该入口的调用权。 */
    async dispatchPendingAsk(resume: ImPendingAskResume, signal: AbortSignal) {
      if (!pending) throw new Error('延迟群回复未装配')
      return pending.dispatch(resume, signal)
    },
    async pumpPendingAsks(signal: AbortSignal) {
      if (!pending || !options.pendingAsks) throw new Error('延迟群回复未装配')
      return pumpImPendingAsks({ store: options.pendingAsks, async authorize(resume, currentSignal) {
        currentSignal.throwIfAborted()
        const binding = { ownerId: resume.scope.ownerId, botId: resume.scope.botId, platform: resume.scope.platform }
        const input = inputOf(binding, resume.trigger.payload)
        const snapshot = await accessFor((sql, args) => options.pool.query(sql, args)).snapshot(input)
        snapshot.actor(input)
        return true
      },
        async dispatch(resume, currentSignal) { await pending.dispatch(resume, currentSignal) } }, signal)
    },
    /** 仅供验证了Gateway专用准入密封的Worker调用，避免旧普通消息误入后来激活的秘密/选项。 */
    prepareAdmitted,
    /** 控制输入先消费，被动消息立即记录；可回复消息在防抖期间早落库。 */
    async prepare(binding: NodeImBotBinding, payload: Payload, eventId: string, signal: AbortSignal): Promise<boolean> {
      if (await preflight(binding, payload, eventId, signal) === 'consumed') return false
      return prepareAdmitted(binding, payload, eventId, signal)
    },
    /** 仅接收已prepare的进程内消息；每段事务仍重新核对当前账户、策略与actor权限。 */
    async handleBatch(binding: NodeImBotBinding, items: readonly ImConversationBatchItem[], signal: AbortSignal) {
      const results: Awaited<ReturnType<typeof store.persistBatch>>[] = []
      let pending: ImConversationBatchItem[] = [], previous: 'reply' | 'passive' | 'control' | null = null
      const flush = async () => {
        if (!pending.length) return
        const batchItems = pending; pending = []
        const result = await store.persistBatch(binding, batchItems, { mode: previous === 'passive' ? 'passive' : 'dispatch',
          ...(options.attention && binding.platform !== 'wechat' && batchItems[0]?.payload.chat_type === 'group' ? {
            async beforeDispatch(segment) {
              const messages = segment.aggregate._batch_messages as Payload[]
              const outcome = await options.attention!.evaluate({ scope: { ownerId: binding.ownerId, botId: binding.botId,
                platform: binding.platform as 'feishu' | 'qq' | 'telegram', groupId: String(segment.aggregate.chat_id) },
                sessionId: segment.anchors[0]!.sessionId,
                candidates: messages.map(payload => ({ eventId: String(payload._node_stream_event_id ?? ''), payload })) }, signal)
              if (outcome.disposition === 'bypass') return null
              const sourceAttentionKind = attentionSourceKind(outcome.decision?.kind)
              return parseImAttentionRecord({ v: 1, disposition: outcome.disposition, mode: outcome.mode,
                configVersion: outcome.configVersion, subjectEventId: outcome.subject?.eventId ?? null,
                sourceAttentionKind, proactive: sourceAttentionKind === 'proactive', replyChoice: outcome.replyChoice })
            },
            async validateAttention(client, record) {
              const current = await client.query(`SELECT group_attention_mode,group_attention_config_version FROM user_bots
                WHERE user_id=$1 AND id=$2 AND platform=$3 AND enabled IS TRUE AND group_requires_at IS FALSE
                  AND group_read_enabled IS FALSE FOR SHARE`, [binding.ownerId, binding.botId, binding.platform])
              const row = current.rows[0]
              const mode = ['quiet', 'natural', 'active', 'autonomous'].includes(row?.group_attention_mode) ? row.group_attention_mode : 'autonomous'
              return current.rows.length === 1 && row.group_attention_config_version === record.configVersion && mode === record.mode
            },
          } : {}),
          async onDispatch(client, segment) {
            const anchor = segment.anchors.at(-1)
            if (!anchor) throw new Error('IM 批次消息锚点缺失')
            return enqueue(client, binding, segment.aggregate, anchor, signal,
              { batchKey: segment.batchKey, segmentKey: segment.segmentKey, messageIds: segment.anchors.map(item => item.messageId) },
              segment.aggregate._node_attention === undefined ? undefined : parseImAttentionRecord(segment.aggregate._node_attention))
          } })
        results.push(result)
        if (result.segments.some(segment => segment.runId)) await notify()
      }
      for (const item of items) {
        signal.throwIfAborted()
        if (await options.retired?.seen(binding,item.payload,signal)) continue
        const mode = await classify(options.pool, binding, item.payload)
        if (mode !== previous) { await flush(); previous = mode }
        if (mode !== 'control') pending.push(item)
      }
      await flush()
      return results
    },
    async handle(binding: NodeImBotBinding, raw: Payload, eventId: string, signal: AbortSignal) {
      // 固定本条载荷；控制输入在任何会话写入前由同一正式preflight消费。
      const payload = structuredClone(raw), input = inputOf(binding, payload)
      if (typeof payload.text !== 'string' || !eventId) throw new Error('IM 入站内容无效')
      signal.throwIfAborted()
      const handled = await preflight(binding, payload, eventId, signal)
      if (handled === 'consumed') return null
      const current = await accessFor((sql, args) => options.pool.query(sql, args)).snapshot(input)
      current.actor(input)
      const mode = await classify(options.pool, binding, payload)
      if (mode === 'control') return null
      if (mode === 'passive') return store.persist(binding, payload, { eventId, mode: 'passive' })
      if (options.attention && input.chatType === 'group' && binding.platform !== 'wechat') {
        if (!await prepareAdmitted(binding, payload, eventId, signal)) return null
        const batches = await ingress.handleBatch(binding, [{ eventId, payload }], signal)
        return batches[0]?.segments[0]?.anchors[0] ?? null
      }
      const anchor = await store.persist(binding, payload, { eventId, mode: 'dispatch', onDispatch: (client, anchor) => enqueue(client, binding, payload, anchor, signal) })
      if (anchor?.runId) await notify()
      return anchor
    },
  }
  return ingress
}
