import { createHash } from 'node:crypto'
import { z } from 'zod'
import { stableJson, type RunIdentity } from '@gugu/core/agent'
import type { ImDeliveryResult, ImRunDeliveryPorts } from '@gugu/core/im/run-delivery'
import type { ImDeliverySession } from '../../delivery/store.js'
import { FeishuApiError, type createFeishuClient } from '@gugu/gateway/feishu'
import { createFeishuSender } from '@gugu/gateway/feishu'
import { buildFeishuStreamingCard } from './streaming.js'
import { FeishuPresentation, type FeishuToolSummaryPolicy } from '@gugu/gateway/feishu'
import { createFeishuRunEventProjector, type FeishuChartRenderer } from './run-events.js'
import { imAcceptedEvidence, type ImAcceptedSource } from '../../agent/evidence.js'
import type { ImAttachmentScope } from '../../inbound/attachments.js'

const hash = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
const id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)
const stateSchema = z.object({ v: z.literal(1), target: z.string().regex(/^[a-f0-9]{64}$/), segment: z.number().int().nonnegative().safe(),
  stage: z.enum(['open', 'paused', 'closing', 'finished']), mode: z.enum(['card', 'plain']), cardId: id.nullable(), messageId: id.nullable(),
  cardSequence: z.number().int().nonnegative().safe(), eventSequence: z.number().int().nonnegative().safe(), accumulated: z.string(),
  presentation: z.unknown(), parser: z.unknown(), patchedLength: z.number().int().nonnegative().safe(), patchedAt: z.number().nonnegative().finite(),
  visibleText: z.string().nullable().default(null), messageIds: z.array(id).max(1000).default([]),
  inflight: z.object({ sequence: z.number().int().positive().safe(), eventId: z.string().min(1).max(256), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().nullable(),
}).strict()
type State = z.infer<typeof stateSchema>
function outcome(error: unknown): ImDeliveryResult {
  return error instanceof FeishuApiError && (error.operation === 'auth' || error.errorCode !== undefined && error.errorCode !== 0
    || error.statusCode !== undefined && error.statusCode >= 300 && error.statusCode < 500) ? 'rejected' : 'unknown'
}
class Blocked extends Error { constructor(readonly outcome: ImDeliveryResult) { super('飞书流式投递未完成') } }

/** 仅由共享run-delivery逐事件调用；所有平台操作均在现有PG租约和持久操作收据内执行。 */
export function createPersistentFeishuProjection(options: {
  identity: RunIdentity; receiveId: string; policyVersion: string
  receipts: ImDeliverySession; client: Pick<ReturnType<typeof createFeishuClient>, 'call'>
  authorize(): Promise<boolean>; toolSummary?: FeishuToolSummaryPolicy; renderCharts?: FeishuChartRenderer
  acceptedEvidence?: { scope: ImAttachmentScope; recipient: string; source(): Promise<ImAcceptedSource> }
  now?(): number
}): NonNullable<ImRunDeliveryPorts<unknown>['stream']> {
  const identity = Object.freeze({ ...options.identity }), store = options.receipts.projection!
  if (!store || !/^(?:ou_|oc_)[A-Za-z0-9_-]{1,256}$/.test(options.receiveId) || !options.policyVersion) throw new Error('飞书持久投影未配置')
  if (options.acceptedEvidence && (options.acceptedEvidence.scope.platform !== 'feishu' || options.acceptedEvidence.scope.ownerId !== identity.ownerId
    || options.acceptedEvidence.recipient !== options.receiveId || typeof options.acceptedEvidence.source !== 'function'
    || options.receiveId !== (options.acceptedEvidence.scope.chatType === 'group' ? options.acceptedEvidence.scope.chatId : options.acceptedEvidence.scope.platformUserId))) throw new Error('飞书持久投影证据无效')
  const receiveId = options.receiveId
  const targetParts = [receiveId, options.policyVersion, options.toolSummary?.chatType ?? null, !!options.toolSummary?.includeDetails]
  const target = hash(options.acceptedEvidence ? [...targetParts, options.acceptedEvidence.scope, options.acceptedEvidence.recipient] : targetParts)
  const client: Pick<ReturnType<typeof createFeishuClient>, 'call'> = { async call(method, path, args) {
    if (!await options.authorize()) throw new FeishuApiError('message', 403)
    return options.client.call(method, path, { ...args, authorize: options.authorize })
  } }
  const sender = createFeishuSender({ client }), now = options.now ?? Date.now
  const fresh = (segment = 0, eventSequence = 0): State => ({ v: 1, target, segment, stage: 'open', mode: 'card', cardId: null, messageId: null,
    cardSequence: 0, eventSequence, accumulated: '', presentation: new FeishuPresentation(options.toolSummary).snapshot(),
    parser: createFeishuRunEventProjector().snapshot(), patchedLength: 0, patchedAt: now(), visibleText: null, messageIds: [], inflight: null })
  return { async project(input) {
    const same = (value: RunIdentity) => value.ownerId === identity.ownerId && value.sessionId === identity.sessionId && value.runId === identity.runId
    if (!same(input.identity) || !same(input.event.identity)) throw new Error('飞书运行身份无效')
    let version: number, state: State
    try {
      const read = await store.read(); version = read.version
      state = read.state === null ? fresh() : stateSchema.parse(read.state)
      if (state.target !== target) throw Error()
      // 总大小由store再次约束；这里验证每个可恢复组件，未知版本不能带着旧配置继续投递。
      FeishuPresentation.restore(state.presentation, options.toolSummary)
      createFeishuRunEventProjector({ checkpoint: state.parser })
    } catch { throw new Error('飞书持久投影状态无效') }
    const event = input.event
    const acknowledged = async () => {
      if (!options.acceptedEvidence || event.type !== 'final' || state.visibleText === null) return 'accepted' as const
      if (!await options.authorize()) return 'rejected' as const
      return imAcceptedEvidence({ scope: options.acceptedEvidence.scope, recipient: options.acceptedEvidence.recipient, kind: 'text',
        source: await options.acceptedEvidence.source(), receipt: { outcome: 'accepted', platformMessageIds: state.messageIds }, text: state.visibleText })
    }
    // Core外层stream:event收据也会阻断重放；此标记使端口本身同样不能绕过半事件已发出的操作。
    if (state.inflight !== null) return 'unknown'
    if (event.sequence <= state.eventSequence) return acknowledged()
    if (!await options.authorize()) return 'rejected'
    if (state.stage === 'finished') return 'rejected'
    if (event.type === 'run_resumed') {
      if (state.stage === 'closing') return 'rejected'
      // 检查点续跑沿用已有投影；只有交互等待结束才开启新段。
      if (state.stage === 'paused') state = fresh(state.segment + 1, state.eventSequence)
    } else if (state.stage === 'paused' && !['interaction_resolved', 'tool_done', 'interaction_required', 'final'].includes(event.type)) return 'rejected'
    if (event.type === 'interaction_resolved' && ['cancelled', 'aborted', 'expired'].includes(String(event.payload.status))) state.stage = 'closing'
    state.inflight = { sequence: event.sequence, eventId: event.id, fingerprint: hash(event) }
    version = await store.checkpoint(version, state)
    let presentation = FeishuPresentation.restore(state.presentation, options.toolSummary)
    const projector = createFeishuRunEventProjector({ checkpoint: state.parser, ...(options.renderCharts ? { renderCharts: options.renderCharts } : {}) })
    let operation = 0
    const snapshot = () => {
      const value = stateSchema.parse({ ...state, presentation: presentation.snapshot(), parser: projector.snapshot() })
      if (Buffer.byteLength(JSON.stringify(value)) > 1048576) throw new Error('飞书持久投影状态超限')
      return value
    }
    async function perform<T>(kind: string, payload: unknown, work: () => Promise<{ result: ImDeliveryResult; value?: T }>, apply: (value: T | undefined) => void): Promise<ImDeliveryResult> {
      const key = `feishu:${state.segment}:${event.sequence}:${++operation}:${kind}`
      snapshot() // 在任何外部副作用前拒绝超限/错误状态。
      if (!await options.authorize()) throw new Blocked('rejected')
      const receipt = await options.receipts.begin(identity, key, hash(payload))
      // 不跳过accepted操作去猜其返回cardId；正常恢复由已保存event/state跳过整个事件，半提交事件保持unknown。
      if (receipt !== 'new') throw new Blocked('unknown')
      if (!await options.authorize()) { await options.receipts.settle(identity, key, 'rejected'); throw new Blocked('rejected') }
      let result: { result: ImDeliveryResult; value?: T }
      try { result = await work() } catch (error) { result = { result: outcome(error) } }
      if (result.result !== 'accepted') { await options.receipts.settle(identity, key, result.result); return result.result }
      apply(result.value)
      // 此提交失败时，平台可能已接受；保留pending并交共享投递器记unknown，绝不另建卡或重发。
      version = await store.accepted(key, version, snapshot())
      return 'accepted'
    }
    const card = (final = false) => { const closed = final || state.stage !== 'open'; const value = buildFeishuStreamingCard('', closed ? '咕咕' : '咕咕思考中', !closed); value.body = { elements: presentation.elements() }; return value }
    async function ensureCard(): Promise<void> {
      if (state.mode === 'plain' || state.messageId || state.stage === 'paused') return
      if (!state.cardId) {
        const body = { type: 'card_json', data: JSON.stringify(buildFeishuStreamingCard('咕咕正在想…')) }
        const result = await perform<string>('create', body, async () => {
          const response = await client.call('POST', '/open-apis/cardkit/v1/cards', { body })
          const value = response.data && typeof response.data === 'object' ? (response.data as Record<string, unknown>).card_id : null
          return typeof value === 'string' && id.safeParse(value).success ? { result: 'accepted', value } : { result: 'unknown' }
        }, value => { state.cardId = value! })
        if (result === 'rejected') { state.mode = 'plain'; return }
        if (result !== 'accepted') throw new Blocked(result)
      }
      const result = await perform<string>('bridge', { receiveId, cardId: state.cardId }, async () => {
        const receipt = await sender.card(receiveId, { type: 'card', data: { card_id: state.cardId } })
        return { result: receipt.outcome === 'accepted' && !id.safeParse(receipt.platformMessageIds[0]).success ? 'unknown' : receipt.outcome, value: receipt.platformMessageIds[0] }
      }, value => { state.messageId = value!; state.messageIds = [value!] })
      if (result === 'rejected') { state.mode = 'plain'; return }
      if (result !== 'accepted') throw new Blocked(result)
    }
    async function edit(kind: 'element' | 'card' | 'settings', body: Record<string, unknown>, final = false): Promise<void> {
      const next = state.cardSequence + 1
      const path = `/open-apis/cardkit/v1/cards/${state.cardId}${kind === 'element' ? `/elements/${presentation.activeId}/content` : kind === 'settings' ? '/settings' : ''}`
      const payload = { ...body, sequence: next, ...(kind === 'card' ? {} : { uuid: hash([identity, state.segment, event.sequence, operation + 1, kind]) }) }
      const result = await perform(kind, payload, async () => { await client.call(kind === 'settings' ? 'PATCH' : 'PUT', path, { body: payload }); return { result: 'accepted' } },
        () => { state.cardSequence = next; if (final) state.stage = event.type === 'interaction_required' ? 'paused' : 'finished' })
      if (result !== 'accepted') throw new Blocked(result)
    }
    try {
      const events = await projector.push(event)
      for (const projected of events) {
        if (projected.type === 'token') {
          state.accumulated += projected.text
          const created = presentation.append(projected.text)
          if (!projected.text) continue
          await ensureCard()
          if (state.mode === 'card' && (created && presentation.used || [...presentation.activeText].length - state.patchedLength >= 30 || now() - state.patchedAt >= 200)) {
            if (created && presentation.used) await edit('card', { card: { type: 'card_json', data: JSON.stringify(card()) } })
            else await edit('element', { content: presentation.activeText })
            state.patchedAt = now(); state.patchedLength = [...presentation.activeText].length
          }
        } else if (projected.type === 'round_end') presentation.endRound()
        else if (projected.type === 'tool_call' || projected.type === 'tool_done') {
          if (presentation.tool(projected)) { await ensureCard(); if (state.mode === 'card' && state.messageId) await edit('card', { card: { type: 'card_json', data: JSON.stringify(card()) } }) }
        } else if (projected.type === 'chart_image') {
          if (!state.messageId || state.mode === 'plain') continue
          const result = await perform<string>('image', { source: hash(projected.source), png: createHash('sha256').update(projected.png).digest('hex') }, async () => {
            const image = await sender.uploadImage(projected.png)
            return { result: image.outcome, value: image.imageKey ?? undefined }
          }, value => { presentation.replace(projected.source, value!) })
          if (result === 'accepted') await edit('card', { card: { type: 'card_json', data: JSON.stringify(card()) } })
          else if (result === 'unknown') throw new Blocked('unknown') // 上传未知不猜测image_key。
        } else if (projected.type === 'final') {
          const text = projected.cancelled ? state.accumulated : projected.text || state.accumulated || (projected.hasFiles ? '给你～' : '嗯~在的，你说～')
          presentation.finish(text, !!projected.cancelled)
          if (text || presentation.used) await ensureCard()
          if (state.mode === 'plain' && (text || presentation.used)) {
            const fallback = options.toolSummary && presentation.used ? presentation.plainText() : text
            const result = await perform<readonly string[]>('fallback', { text: fallback }, async () => {
              const receipt = await sender.text(receiveId, fallback)
              return { result: receipt.outcome, value: receipt.platformMessageIds }
            }, ids => { state.messageIds = [...(ids ?? [])]; state.visibleText = fallback })
            if (result !== 'accepted') throw new Blocked(result)
          } else if (state.messageId) {
            await edit('card', { card: { type: 'card_json', data: JSON.stringify(card()) } })
            await edit('settings', { settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: [...text.trim()].slice(0, 80).join('') || '✅' } } }) })
            await edit('card', { card: { type: 'card_json', data: JSON.stringify(card(true)) } }, true)
            state.visibleText = presentation.plainText()
          }
          state.stage = 'finished'
        }
      }
      if (event.type === 'interaction_required') {
        if (state.messageId && state.mode === 'card') {
          await edit('settings', { settings: JSON.stringify({ config: { streaming_mode: false } }) })
          await edit('card', { card: { type: 'card_json', data: JSON.stringify(card(true)) } }, true)
        }
        state.stage = 'paused'
      }
      state.eventSequence = event.sequence
      state.inflight = null
      version = await store.checkpoint(version, snapshot())
      return acknowledged()
    } catch (error) { if (error instanceof Blocked) return error.outcome; throw error }
  } }
}
