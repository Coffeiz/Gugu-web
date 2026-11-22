import { isImInternalDelegationTool } from './access.js'
import { describeShellActivity, type ShellActivity } from '../agent/shell-activity.js'
import { BUILTIN_AGENT_TOOL_STATE_LABELS } from '../agent/sessions/state-labels.js'
import type { AgentRunner, PortableValue, RunEvent, RunIdentity } from '../agent/models.js'
import { normalizePersistentArtifact } from '../agent/context/history/attachment-refs.js'

const shellLabels: Readonly<Record<ShellActivity['action'], string>> = {
  directory: '查看目录', read: '读取文件', search: '搜索内容', find: '查找文件',
  check: '检查与统计', checks: '执行多项检查', git: '查看 Git 状态', git_diff: '查看 Git 差异',
  git_history: '查看 Git 历史', build: '构建项目', test: '运行测试',
}

function defaultToolLabel(name: string): string {
  return Object.hasOwn(BUILTIN_AGENT_TOOL_STATE_LABELS, name) ? BUILTIN_AGENT_TOOL_STATE_LABELS[name]! : name
}

/** IM 标题只使用动作，不带命令参数或本机文件名。 */
export function resolveImToolLabel(name: string | undefined, display?: unknown, label?: string): string {
  const item = display && typeof display === 'object'
    ? display as { shellActivity?: ShellActivity; toolInput?: unknown; toolResult?: unknown; toolLabelOverride?: unknown }
    : undefined
  if (name === 'shell' && item) {
    const action = item.shellActivity?.action ?? describeShellActivity(item.toolInput, item.toolResult)?.action
    if (action && Object.hasOwn(shellLabels, action)) return shellLabels[action]
  }
  const override = typeof item?.toolLabelOverride === 'string' ? item.toolLabelOverride.trim() : ''
  // IM 展示名称独立于旧回执指纹，重放时仍按原动作标识去重。
  if (name === 'http_get') return label?.trim() || override || '抓取网页'
  return label?.trim() || override || (name === 'shell' ? '执行 Shell 命令' : name?.trim() ? defaultToolLabel(name.trim()) : '工具')
}

function toolStatusText(label: string, status: unknown): string {
  if (status === 'success' || status === 'ok') return `✅ ${label}完成`
  if (status === 'waiting') return `⏸️ ${label}：任务已暂停，等待确认`
  return `⚠️ ${label}未完成`
}

export function formatImToolStatus(label: string, status: unknown,
  sanitize: (label: string) => string = value => value): string {
  const safe = [...sanitize(label.replace(/\s+/gu, ' '))].slice(0, 80).join('')
  return toolStatusText(safe, status)
}

export type ImDeliveryResult = 'accepted' | 'rejected' | 'unknown'
export type ImDeliveryAcknowledgement = ImDeliveryResult | { readonly outcome: ImDeliveryResult; readonly evidence?: PortableValue }
/** 由真实outbox事件产生，平台回执不得自行声明final。 */
export interface ImDeliveryEventFact { readonly eventType: RunEvent['type']; readonly sequence: number; readonly final: boolean }
export interface ImRunDeliveryPorts<C> {
  readonly runner: Pick<AgentRunner<C>, 'start'>
  /** 必须查询已提交、按sequence排序的持久outbox；独立于Runner发布ACK。 */
  readonly events: { readAfter(identity: RunIdentity, sequence: number): Promise<readonly RunEvent[]> }
  /** Host实现必须按owner/session/run隔离并以CAS或租约串行化整个投递过程。 */
  readonly receipts: {
    cursor(identity: RunIdentity): Promise<number>
    /** 原子登记意图；相同key不同fingerprint必须报错。pending表示结果不明，不得重发。 */
    begin(identity: RunIdentity, key: string, fingerprint: string): Promise<'new' | 'accepted' | 'pending' | 'unknown'>
    settle(identity: RunIdentity, key: string, result: ImDeliveryResult, evidence?: PortableValue, event?: ImDeliveryEventFact): Promise<void>
    /** round_end已发送时，只提升相同正文的终态事实，绝不再次调用平台。 */
    confirmFinal?(identity: RunIdentity, key: string, fingerprint: string, event: ImDeliveryEventFact): Promise<void>
    advance(identity: RunIdentity, expectedSequence: number, nextSequence: number): Promise<void>
  }
  /** 稳定规范JSON的不可逆摘要；对象字段顺序不影响结果，不得返回正文、附件名或凭据。 */
  digest(value: unknown): string
  authorize(identity: RunIdentity): Promise<boolean>
  /** 同一持久投递入口的可选平台流投影；正文由它独占，不能在observeRun旁路发送。 */
  /** 宿主按平台与用户偏好决定是否提前发送普通消息的中间轮正文。 */
  readonly showIntermediateReplies?: boolean
  readonly stream?: { project(input: { identity: RunIdentity; deliveryId: string; event: RunEvent }): Promise<ImDeliveryAcknowledgement> }
  readonly sender: {
    text(input: { identity: RunIdentity; deliveryId: string; text: string }): Promise<ImDeliveryAcknowledgement>
    compactionNotice?(input: { identity: RunIdentity; deliveryId: string; text: string }): Promise<ImDeliveryAcknowledgement>
    toolNotice?(input: { identity: RunIdentity; deliveryId: string; text: string }): Promise<ImDeliveryAcknowledgement>
    artifact(input: { identity: RunIdentity; deliveryId: string; artifact: PortableValue }): Promise<ImDeliveryAcknowledgement>
    /** 可信交互服务按event身份读取prompt；不转发工具参数或秘密。 */
    interaction(input: { identity: RunIdentity; deliveryId: string; event: RunEvent }): Promise<ImDeliveryAcknowledgement>
  }
}

/** 公开错误只保留固定原因，不携带上游异常、聊天或附件信息。 */
export class ImRunDeliveryBlocked extends Error {
  constructor(readonly reason: 'unauthorized' | 'rejected' | 'unknown' | 'stopped') { super('IM 投递尚未完成'); this.name = 'ImRunDeliveryBlocked' }
}
function sameIdentity(left: RunIdentity, right: RunIdentity): boolean {
  return left.ownerId === right.ownerId && left.sessionId === right.sessionId && left.runId === right.runId
}
function validateIdentity(identity: RunIdentity): void {
  if (![identity.ownerId, identity.sessionId, identity.runId].every(value => typeof value === 'string' && value.length > 0))
    throw new TypeError('IM 运行身份无效')
}

/** 已提交Run事件到IM的串行投递。这里没有模型循环，也不实现存储或平台协议。 */
function createDelivery<C>(ports: Omit<ImRunDeliveryPorts<C>, 'runner'>) {
  async function readCursor(identity: RunIdentity): Promise<number> {
    validateIdentity(identity)
    const cursor = await ports.receipts.cursor(identity)
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('IM 投递游标无效')
    return cursor
  }
  function validateEvent(identity: RunIdentity, event: RunEvent, sequence: number): void {
    if (!sameIdentity(identity, event.identity)) throw new Error('IM 事件运行身份不匹配')
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || !Number.isSafeInteger(event.round) || event.round < 0 || typeof event.id !== 'string' || !event.id)
      throw new Error('IM 运行事件无效')
    if (event.sequence > sequence + 1) throw new Error('IM 运行事件序列缺失')
  }
  async function deliver(identity: RunIdentity, key: string, value: unknown, send: (deliveryId: string) => Promise<ImDeliveryAcknowledgement>, signal?: AbortSignal, event?: ImDeliveryEventFact): Promise<void> {
    if (signal?.aborted) throw new ImRunDeliveryBlocked('stopped')
    if (!await ports.authorize(identity)) throw new ImRunDeliveryBlocked('unauthorized')
    const fingerprint = ports.digest(value)
    const receipt = await ports.receipts.begin(identity, key, fingerprint)
    if (receipt === 'accepted') {
      if (event?.final) await ports.receipts.confirmFinal?.(identity, key, fingerprint, event)
      return
    }
    if (receipt !== 'new') throw new ImRunDeliveryBlocked('unknown')
    // 意图登记后再复核授权，避免异步存储期间撤权仍然发出消息。
    const authorized = await ports.authorize(identity)
    if (signal?.aborted || !authorized) {
      await ports.receipts.settle(identity, key, 'rejected')
      throw new ImRunDeliveryBlocked(signal?.aborted ? 'stopped' : 'unauthorized')
    }
    let acknowledgement: ImDeliveryAcknowledgement
    try { acknowledgement = await send(ports.digest([identity.ownerId, identity.sessionId, identity.runId, key])) }
    catch {
      await ports.receipts.settle(identity, key, 'unknown')
      throw new ImRunDeliveryBlocked('unknown')
    }
    let result = typeof acknowledgement === 'string' ? acknowledgement : acknowledgement?.outcome
    let evidence = typeof acknowledgement === 'object' && acknowledgement !== null && result === 'accepted' ? acknowledgement.evidence : undefined
    try {
      // 仅传递有界可移植JSON；Host另行复核平台事实和完整可信scope。
      let count = 0
      const validate = (value: unknown, depth: number): void => {
        if (++count > 8192 || depth > 12) throw Error()
        if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return
        if (Array.isArray(value)) { for (const item of value) validate(item, depth + 1); return }
        if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw Error()
        for (const item of Object.values(value)) validate(item, depth + 1)
      }
      if (evidence !== undefined) { validate(evidence, 0); if (new TextEncoder().encode(JSON.stringify(evidence)).length > 65536) throw Error() }
    } catch { result = 'unknown'; evidence = undefined }
    if (!['accepted', 'rejected', 'unknown'].includes(result)) result = 'unknown'
    await ports.receipts.settle(identity, key, result, evidence, event)
    if (result !== 'accepted') throw new ImRunDeliveryBlocked(result)
  }
  async function project(identity: RunIdentity, event: RunEvent, sequence: number, signal?: AbortSignal): Promise<number> {
    validateEvent(identity, event, sequence)
    if (event.sequence <= sequence) return sequence
    if (signal?.aborted) throw new ImRunDeliveryBlocked('stopped')
    const text = typeof event.payload.text === 'string' ? event.payload.text : ''
    const fact: ImDeliveryEventFact = { eventType: event.type, sequence: event.sequence, final: event.type === 'final' && event.payload.status === 'completed' && text.trim().length > 0 }
    if (event.type === 'final' && !['completed', 'failed', 'unknown', 'cancelled'].includes(String(event.payload.status))) throw new Error('IM 运行终态无效')
    if (event.type === 'interaction_required' && (typeof event.payload.interactionId !== 'string' || !event.payload.interactionId
      || !['question', 'confirmation', 'credential'].includes(String(event.payload.kind)) || typeof event.payload.toolCallId !== 'string' || !event.payload.toolCallId)) throw new Error('IM 交互身份无效')
    if (event.type === 'interaction_resolved' && (typeof event.payload.interactionId !== 'string' || !event.payload.interactionId
      || !['answered', 'confirmed', 'cancelled', 'aborted', 'expired'].includes(String(event.payload.status)))) throw new Error('IM 交互结果身份无效')
    const internalTool = (event.type === 'tool_call' || event.type === 'tool_done')
      && isImInternalDelegationTool(event.payload.name)
    if (ports.stream && !internalTool && ['token', 'tool_call', 'tool_done', 'round_end', 'final', 'interaction_required', 'interaction_resolved', 'run_resumed'].includes(event.type)) {
      const streamed = event.type === 'interaction_required' ? { ...event, payload: { interactionId: event.payload.interactionId, kind: event.payload.kind, toolCallId: event.payload.toolCallId } }
        : event.type === 'interaction_resolved' ? { ...event, payload: { interactionId: event.payload.interactionId, status: event.payload.status } } : event
      await deliver(identity, `stream:${event.sequence}`, streamed, deliveryId => ports.stream!.project({ identity, deliveryId, event: streamed }), signal, fact)
    }
    if (ports.sender.compactionNotice && event.type === 'compaction') {
      const { phase, applied } = event.payload
      const notice = phase === 'started' ? '上下文较长，正在整理后继续处理。'
        : phase === 'completed' && typeof applied === 'boolean'
          ? applied ? '上下文整理完成。' : '本次未能整理上下文，继续处理。'
          : null
      if (notice) {
        try {
          await deliver(identity, `compaction-notice:${event.sequence}`, notice,
            deliveryId => ports.sender.compactionNotice!({ identity, deliveryId, text: notice }), signal)
        } catch (error) {
          if (!(error instanceof ImRunDeliveryBlocked) || !['unknown', 'rejected'].includes(error.reason)) throw error
        }
      }
    }
    if (ports.sender.toolNotice && event.type === 'tool_done' && !internalTool) {
      const { name, status } = event.payload
      if (typeof name === 'string' && /^[\w.:-]{1,120}$/u.test(name) && name !== 'choose_no_reply') {
        const notice = formatImToolStatus(resolveImToolLabel(name, event.payload.display), status)
        try {
          // 提示独立记账，投递不明时不得阻塞后续正文或重复外发。
          // 保留已登记的摘要指纹，避免旧回执在恢复游标时产生冲突。
          await deliver(identity, `tool-notice:${event.sequence}`, toolStatusText(defaultToolLabel(name), status),
            deliveryId => ports.sender.toolNotice!({ identity, deliveryId, text: notice }), signal)
        } catch (error) {
          if (!(error instanceof ImRunDeliveryBlocked) || !['unknown', 'rejected'].includes(error.reason)) throw error
        }
      }
    }
    if (!ports.stream && ports.showIntermediateReplies !== false && event.type === 'round_end' && text) {
      await deliver(identity, `round:${event.round}:text`, text, deliveryId => ports.sender.text({ identity, deliveryId, text }), signal, fact)
    } else if (event.type === 'interaction_required') {
      if (typeof event.payload.interactionId !== 'string' || !event.payload.interactionId ||
        !['question', 'confirmation', 'credential'].includes(String(event.payload.kind)) ||
        typeof event.payload.toolCallId !== 'string' || !event.payload.toolCallId) throw new Error('IM 交互身份无效')
      // 只把交互标识交给可信sender，拒绝将意外附带的工具正文透传。
      const safeEvent = { ...event, payload: { interactionId: event.payload.interactionId, kind: event.payload.kind, toolCallId: event.payload.toolCallId } }
      await deliver(identity, `interaction:${event.payload.interactionId}`, safeEvent.payload, deliveryId => ports.sender.interaction({ identity, deliveryId, event: safeEvent }), signal, { ...fact, final: false })
    } else if (!ports.stream && event.type === 'final') {
      const status = event.payload.status
      if (!['completed', 'failed', 'unknown', 'cancelled'].includes(String(status))) throw new Error('IM 运行终态无效')
      if (text && status !== 'cancelled') {
        // 正常final与round_end共用key；early-exit无round_end也能投递。
        const key = status === 'completed' ? `round:${event.round}:text` : `final:${event.sequence}:text`
        await deliver(identity, key, text, deliveryId => ports.sender.text({ identity, deliveryId, text }), signal, fact)
      }
    }
    if (event.type === 'final' && event.payload.status !== 'cancelled' && event.payload.files !== undefined && !Array.isArray(event.payload.files))
      throw new Error('IM 制品列表无效')
    const artifacts: unknown[] = event.type === 'tool_done' && event.payload.artifact !== undefined ? [event.payload.artifact]
      : event.type === 'final' && event.payload.status !== 'cancelled' && Array.isArray(event.payload.files) ? event.payload.files : []
    for (const value of artifacts) {
      const artifact = normalizePersistentArtifact(value)
      const key = `artifact:${ports.digest(artifact)}`
      await deliver(identity, key, artifact, deliveryId => ports.sender.artifact({ identity, deliveryId, artifact }), signal, { ...fact, final: false })
    }
    await ports.receipts.advance(identity, sequence, event.sequence)
    return event.sequence
  }
  /** 由既有持久调度器选定start/resume；投递器只消费该真实运行，不自行决定重启。 */
  async function consume(identity: RunIdentity, events: AsyncIterable<RunEvent>, signal?: AbortSignal): Promise<void> {
      let sequence = await readCursor(identity)
      let deliveryError: unknown
      let blocked = false
      for await (const event of events) {
        if (blocked) continue
        try { sequence = await project(identity, event, sequence, signal) }
        catch (error) { blocked = true; deliveryError = error }
      }
      if (blocked) throw deliveryError
  }
  return {
    consume,
    /** 仅重放已提交出站事件，绝不启动Provider、工具或Runner.resume。 */
    async recover(identity: RunIdentity, signal?: AbortSignal): Promise<void> {
      let sequence = await readCursor(identity)
      // 生产RunStore按页读取outbox；不能把一页成功误报为全部投递已完成。
      while (true) {
        if (signal?.aborted) throw new ImRunDeliveryBlocked('stopped')
        const events = await ports.events.readAfter(identity, sequence)
        if (!events.length) return
        const previous = sequence
        for (const event of events) sequence = await project(identity, event, sequence, signal)
        if (sequence <= previous) throw new Error('IM 投递恢复游标未前进')
      }
    },
  }
}

/** 活Run投递共用恢复规则；投递停止后仍排空真实Runner，业务取消由Runner管理。 */
export function createImRunDelivery<C>(ports: ImRunDeliveryPorts<C>) {
  const delivery = createDelivery(ports)
  return { ...delivery, async start(identity: RunIdentity, options?: Parameters<AgentRunner<C>['start']>[1], signal?: AbortSignal) {
    await delivery.consume(identity, ports.runner.start(identity, options), signal)
  } }
}

/** 独立恢复只接受持久outbox与实际sender，不要求或构造Runner。 */
export function createImRunDeliveryRecovery<C>(ports: Omit<ImRunDeliveryPorts<C>, 'runner'>) {
  const delivery = createDelivery(ports)
  return { recover: delivery.recover }
}
