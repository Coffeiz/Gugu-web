import type { ImConversationScope } from '../../ir/inbound.js'
import type { ImPlatformProjectionStore } from '../../runtime/projection-store.js'
import { createHash, randomInt } from 'node:crypto'
import { z } from 'zod'
import { stableJson, type RunIdentity } from '@gugu/core/agent'
import type { ImDeliveryAcknowledgement, ImDeliveryResult, ImRunDeliveryPorts } from '@gugu/core/im/run-delivery'
import type { createTelegramSender, TelegramDeliveryReceipt, TelegramTarget } from './sender.js'
import { createFeishuRunEventProjector } from '../feishu/index.js'
import type { ImChartRenderer as FeishuChartRenderer } from '../../index.js'
import { formatImToolReceipt } from '../../index.js'
import type { FeishuToolSummaryPolicy } from '../feishu/index.js'

const hash = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
const id = z.string().regex(/^[1-9]\d*$/).max(32)
const stateSchema = z.object({
  v: z.literal(1), target: z.string().regex(/^[a-f0-9]{64}$/), stage: z.enum(['open', 'paused', 'closing', 'finished']),
  segment: z.number().int().nonnegative().safe(), eventSequence: z.number().int().nonnegative().safe(),
  draftId: z.number().int().positive().safe(), draftEnabled: z.boolean(), draftText: z.string(), lastDraftText: z.string(),
  draftRevision: z.number().int().nonnegative().safe(),
  lastDraftAt: z.number().nonnegative().finite(), separator: z.boolean(), trimLeading: z.boolean(),
  round: z.number().int().nonnegative().safe(), roundText: z.string(), roundHasText: z.boolean(),
  pending: z.string(), tools: z.array(z.string()).max(1000), chartStreaming: z.boolean(), parser: z.unknown(),
  visible: z.array(z.object({ text: z.string(), ids: z.array(id).max(1000) }).strict()).max(1000),
  inflight: z.object({ sequence: z.number().int().positive().safe(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().nullable(),
}).strict()
type State = z.infer<typeof stateSchema>
class Blocked extends Error { constructor(readonly outcome: ImDeliveryResult) { super('Telegram 流式投递未完成') } }

/** 唯一调用者是共享run-delivery；草稿不是正式成功送达事实，不能替代final收据。 */
export interface TelegramProjectionOptions {
  identity: RunIdentity; target: TelegramTarget; policyVersion: string; receipts: Pick<ImRunDeliveryPorts<unknown>['receipts'], 'begin' | 'settle'> & { projection?: ImPlatformProjectionStore }
  sender: Pick<ReturnType<typeof createTelegramSender>, 'draft' | 'text' | 'file'>
  authorize(): Promise<boolean>
  signal?: AbortSignal
  acceptedEvidence?: { scope: ImConversationScope; recipient: string; accept(value: { platformMessageIds: string[]; text: string }): Promise<ImDeliveryAcknowledgement> }
  showIntermediateReplies?: boolean; toolSummary?: FeishuToolSummaryPolicy; renderCharts?: FeishuChartRenderer; now?(): number
}

export function createPersistentTelegramProjection(options: TelegramProjectionOptions): NonNullable<ImRunDeliveryPorts<unknown>['stream']> & { close(): Promise<void> } {
  const identity = Object.freeze({ ...options.identity }), target = Object.freeze({ ...options.target }), store = options.receipts.projection!
  if (!store || store.platform !== 'telegram' || target.chatType !== 'c2c' || !/^[1-9]\d*$/.test(target.chatId) || !options.policyVersion
    || target.replyToMessageId !== undefined && !/^[1-9]\d*$/.test(target.replyToMessageId)) throw new Error('Telegram 持久投影未配置')
  const proof = options.acceptedEvidence
  if (proof && (proof.scope.platform !== 'telegram' || proof.scope.ownerId !== identity.ownerId || proof.scope.chatType !== 'c2c'
    || proof.scope.chatId !== null || proof.scope.platformUserId !== target.chatId || proof.recipient !== target.chatId)) throw new Error('Telegram 持久投影证据无效')
  const targetHash = hash([target, options.policyVersion, !!options.showIntermediateReplies, !!options.toolSummary, !!options.toolSummary?.includeDetails,
    proof ? [proof.scope, proof.recipient] : null])
  const now = options.now ?? Date.now
  const fresh = (segment = 0, eventSequence = 0, visible: State['visible'] = []): State => ({ v: 1, target: targetHash,
    stage: 'open', segment, eventSequence, draftId: randomInt(1, 2 ** 48 - 1), draftEnabled: true, draftText: '', lastDraftText: '',
    lastDraftAt: 0, draftRevision: 0, separator: false, trimLeading: false, round: 0, roundText: '', roundHasText: false, pending: '', tools: [],
    chartStreaming: false, parser: createFeishuRunEventProjector().snapshot(), visible, inflight: null })
  let stopped = false, queued = false, tail: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const result = tail.then(work); tail = result.catch(() => undefined); return result }
  // 保活只覆盖同draftId；与事件消费共享串行队列，close在Host释放投递租约前排空。
  const timer = setInterval(() => {
    if (stopped || queued) return
    queued = true
    void serial(async () => {
      if (stopped) return
      const read = await store.read()
      if (read.state === null) return
      const state = stateSchema.parse(read.state)
      if (state.target !== targetHash || state.inflight || state.stage !== 'open' || !state.draftEnabled || !state.lastDraftText || now() - state.lastDraftAt < 15000) return
      let version = read.version
      const save = async () => { version = await store.checkpoint(version, stateSchema.parse(state)) }
      await sendDraft(state, version, save)
    }).catch(() => { stopped = true; clearInterval(timer) }).finally(() => { queued = false })
  }, 15000)
  timer.unref()
  async function sendDraft(state: State, version: number, save: () => Promise<void>): Promise<number> {
    if (!await options.authorize()) throw new Blocked('rejected')
    const points = [...state.draftText], preview = points.length > 4096 ? `${points.slice(0, 2044).join('')}\n…\n${points.slice(-2049).join('')}` : state.draftText
    const key = `telegram:draft:${state.segment}:${state.draftId}:${state.draftRevision + 1}`
    if (await options.receipts.begin(identity, key, hash([preview, state.draftId])) !== 'new') {
      state.draftEnabled = false; await save(); return version + 1
    }
    if (stopped || !await options.authorize()) { await options.receipts.settle(identity, key, 'rejected'); throw new Blocked('rejected') }
    let sent = false
    try { sent = await options.sender.draft(target, preview, state.draftId, options.signal, options.authorize) } catch { /* 仅禁用预览；正式正文仍待后续事件投递。 */ }
    state.draftRevision++
    if (sent) {
      state.lastDraftAt = now(); state.lastDraftText = state.draftText
      return store.accepted(key, version, stateSchema.parse(state))
    }
    await options.receipts.settle(identity, key, 'unknown')
    state.draftEnabled = false; await save(); return version + 1
  }
  async function project(input: Parameters<NonNullable<ImRunDeliveryPorts<unknown>['stream']>['project']>[0]) {
    if (stopped) return 'rejected' as const
    const same = (value: RunIdentity) => value.ownerId === identity.ownerId && value.sessionId === identity.sessionId && value.runId === identity.runId
    if (!same(input.identity) || !same(input.event.identity)) throw new Error('Telegram 运行身份无效')
    let version: number, state: State
    try {
      const read = await store.read(); version = read.version
      state = read.state === null ? fresh() : stateSchema.parse(read.state)
      if (state.target !== targetHash) throw Error()
      createFeishuRunEventProjector({ checkpoint: state.parser })
    } catch { throw new Error('Telegram 持久投影状态无效') }
    const event = input.event
    const initialState = structuredClone(state)
    const acknowledged = async () => {
      if (!proof || event.type !== 'final' || !state.visible.length) return 'accepted' as const
      if (!await options.authorize()) return 'rejected' as const
      return proof.accept({ platformMessageIds: state.visible.flatMap(value => value.ids),
        text: state.visible.map(value => value.text).filter(Boolean).join('\n\n') })
    }
    if (state.inflight) return 'unknown'
    if (event.sequence <= state.eventSequence) return acknowledged()
    if (!await options.authorize() || state.stage === 'finished') return 'rejected'
    if (event.type === 'run_resumed') {
      if (state.stage === 'closing') return 'rejected'
      // 检查点续跑沿用已有投影；只有交互等待结束才开启新段。
      if (state.stage === 'paused') state = fresh(state.segment + 1, state.eventSequence, state.visible)
    } else if (state.stage === 'paused' && !['interaction_resolved', 'tool_done', 'interaction_required', 'final'].includes(event.type)) return 'rejected'
    if (event.type === 'interaction_resolved' && ['cancelled', 'aborted', 'expired'].includes(String(event.payload.status))) state.stage = 'closing'
    const snapshot = () => {
      const checked = stateSchema.parse(state)
      if (Buffer.byteLength(JSON.stringify(checked)) > 1048576) throw new Error('Telegram 持久投影状态超限')
      return checked
    }
    state.inflight = { sequence: event.sequence, fingerprint: hash(event) }
    version = await store.checkpoint(version, snapshot())
    let operation = 0, acceptedFormal = false
    async function perform(kind: string, body: unknown, work: () => Promise<TelegramDeliveryReceipt>, apply: (ids: readonly string[]) => void) {
      snapshot()
      if (!await options.authorize()) throw new Blocked('rejected')
      const key = `telegram:${state.segment}:${event.sequence}:${++operation}:${kind}`
      if (await options.receipts.begin(identity, key, hash(body)) !== 'new') throw new Blocked('unknown')
      if (!await options.authorize()) { await options.receipts.settle(identity, key, 'rejected'); throw new Blocked('rejected') }
      let result: TelegramDeliveryReceipt
      try { result = await work() } catch { result = { outcome: 'unknown', platformMessageIds: [] } }
      if (result.outcome !== 'accepted') { await options.receipts.settle(identity, key, result.outcome); throw new Blocked(result.outcome) }
      if (!result.platformMessageIds.length || result.platformMessageIds.some(value => !id.safeParse(value).success)) throw new Blocked('unknown')
      acceptedFormal = true
      apply(result.platformMessageIds)
      version = await store.accepted(key, version, snapshot())
    }
    async function flush() {
      const text = state.pending.trim()
      if (!text) { state.pending = ''; return }
      await perform('text', { text, target }, () => options.sender.text(target, text, { signal: options.signal, authorize: options.authorize }), ids => {
        state.visible.push({ text, ids: [...ids] }); state.pending = ''
      })
    }
    async function draft(force = false) {
      if (!state.draftEnabled || !state.draftText.trim() || !force && !!state.lastDraftText && now() - state.lastDraftAt < 1000
        || force && state.draftText === state.lastDraftText && now() - state.lastDraftAt < 15000) return
      snapshot()
      version = await sendDraft(state, version, async () => { version = await store.checkpoint(version, snapshot()) })
      if (!await options.authorize()) throw new Blocked('rejected')
    }
    const append = (value: string, assistant = true) => {
      if (assistant && state.trimLeading) { value = value.trimStart(); if (value) state.trimLeading = false }
      if (!value) return
      const text = `${state.separator ? '\n\n' : ''}${value}`; state.separator = false
      state.roundText += text; state.pending += text; state.draftText += text
      if (assistant) state.roundHasText = true
    }
    const resetDraft = () => { state.draftId = randomInt(1, 2 ** 48 - 1); state.draftText = ''; state.lastDraftText = ''; state.lastDraftAt = 0; state.separator = false }
    const projector = createFeishuRunEventProjector({ checkpoint: state.parser, renderCharts: options.renderCharts, signal: options.signal })
    try {
      const projectedEvents = await projector.push(event)
      for (const projected of projectedEvents) {
        if (projected.type === 'token') { append(projected.text); await draft() }
        else if (projected.type === 'tool_done' && options.toolSummary) {
          const text = formatImToolReceipt(projected, options.toolSummary.sanitize)
          if (text) { state.separator = !!state.draftText.trim(); append(text, false); state.tools.push(text); state.separator = true; await draft() }
        } else if (projected.type === 'chart_image') {
          const position = state.pending.indexOf(projected.source)
          if (position < 0) continue
          const tail = state.pending.slice(position + projected.source.length)
          state.pending = state.pending.slice(0, position).trimEnd()
          await flush()
          // 仅确定拒绝可回退源码，未知图片投递绝不再发源码制造重复。
          let rejected = false
          try {
            await perform('chart', { source: hash(projected.source), bytes: createHash('sha256').update(projected.png).digest('hex') },
              () => options.sender.file(target, projected.png, 'chart.png', options.signal, options.authorize), ids => state.visible.push({ text: '', ids: [...ids] }))
          } catch (error) { if (!(error instanceof Blocked) || error.outcome !== 'rejected') throw error; rejected = true }
          if (rejected) { state.pending = projected.source; await flush() }
          state.chartStreaming = true; resetDraft(); state.roundText = ''; state.roundHasText = false; state.trimLeading = true
          state.pending = tail.trimStart(); state.draftText = state.pending
        } else if (projected.type === 'round_end') {
          const fallback = typeof event.payload.text === 'string' ? event.payload.text : ''
          if (!state.roundHasText && !state.chartStreaming && fallback.trim()) append(fallback)
          await draft(true)
          if (state.chartStreaming) { await flush(); resetDraft() }
          else if (state.draftText.trim()) state.separator = true
          state.round++; state.roundText = ''; state.roundHasText = false; state.trimLeading = false
        } else if (projected.type === 'final') {
          if (!state.chartStreaming) {
            if (!options.showIntermediateReplies && !projected.cancelled && projected.text) state.pending = [...state.tools, projected.text].filter(Boolean).join('\n\n')
            else if (!state.pending.trim() && !state.visible.length && projected.text.trim()) state.pending = projected.text
          } else if (!state.pending.trim() && !state.visible.length && projected.text.trim()) state.pending = projected.text
          if (!state.pending.trim() && !state.visible.length && !projected.cancelled) state.pending = projected.hasFiles ? '给你～' : '嗯~在的，你说～'
          await draft(true); await flush(); state.stage = 'finished'
        }
      }
      if (event.type === 'interaction_required') { await draft(true); await flush(); resetDraft(); state.stage = 'paused' }
      state.parser = projector.snapshot(); state.eventSequence = event.sequence; state.inflight = null
      version = await store.checkpoint(version, snapshot())
      return acknowledged()
    } catch (error) {
      if (error instanceof Blocked) {
        // 明确拒绝且本事件尚无正式副作用时，可重放原事件。回滚parser/buffer，不能再次append同一token。
        // draft只是覆盖预览；任何正式accepted或未知平台/DB结果都必须保留inflight，禁止重发。
        if (error.outcome === 'rejected' && !acceptedFormal) {
          state = initialState
          version = await store.checkpoint(version, snapshot())
        }
        return error.outcome
      }
      throw error
    }
  }
  return { project: input => serial(() => project(input)), async close() { stopped = true; clearInterval(timer); await tail } }
}
