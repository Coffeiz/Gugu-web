import type { PendingInteraction,ToolResult } from '../contracts.js';

import type { Block,CanonicalAreaSnapshot,CanonicalContext,CanonicalMessage,CanonicalToolCall,EntryInput,HistoryEnvelope,Json,MessageEntry,OpaqueProviderProjection,PersistenceDelta,PersistencePolicy,PortableValue,ProjectionIdentity,ToolCall } from '../contracts.js';
import { HarnessError } from '../contracts.js';
import type { ContextServices,ProviderProjectionPort } from '../ports.js';

/** 一个 Run 的有序 ledger。公开读取均复制，避免异步 Provider 和持久化共享可变正文。 */
export class MessageArea {
  #entries: MessageEntry[] = [];
  #revision = 0;
  #nextSequence = 0;
  #prefix: CanonicalMessage[] = [];
  #dynamicTail: CanonicalMessage[] = [];
  #batches = new Map<string, Record<string, Json>>();
  protectedHistoryStart: number | null = null;
  constructor(readonly services: ContextServices, restored: readonly CanonicalMessage[] = []) {
    this.#entries = restored.map((message, sequence) => ({
      entryId: services.nextId(), sequence,
      revision: 0, message: canonicalizeMessage(message), source: 'restored_history', persistencePolicy: 'already_persisted',
      persistedMessageId: message._history_id != null ? String(message._history_id) : null
    }))
    this.#nextSequence = this.#entries.length
  }
  static restore(services: ContextServices, snapshot: CanonicalAreaSnapshot): MessageArea {
    const { checkpointDigest, ...checkpoint } = snapshot
    if (services.digest(checkpoint) !== checkpointDigest)
      throw new Error('Canonical 持久化快照指纹不匹配')
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0)
      throw new Error('Canonical revision 无效')
    let previous = -1
    const ids = new Set<string>()
    for (const entry of snapshot.entries) {
      if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= previous || !entry.entryId || ids.has(entry.entryId))
        throw new Error('Canonical sequence 必须严格递增且身份唯一')
      if (entry.revision > snapshot.revision || entry.revision < 0)
        throw new Error('Canonical entry revision 无效')
      assertCanonicalInput(entry.message)
      if (!['restored_history', 'user', 'rag', 'stance', 'message_time', 'runtime', 'reference', 'attachment', 'tool_round', 'agent_followup', 'unknown'].includes(entry.source)
        || !['already_persisted', 'commit_on_success', 'commit_on_interruption', 'request_only', 'reconstruct_on_restore'].includes(entry.persistencePolicy))
        throw new Error('Canonical entry来源或持久策略无效')
      ids.add(entry.entryId)
      previous = entry.sequence
    }
    const area = new MessageArea(services)
    area.#entries = copy(snapshot.entries)
    area.#revision = snapshot.revision
    area.#nextSequence = previous + 1
    const active = new Set(area.#entries.map(entry => entry.batchId))
    for (const batch of snapshot.batches) {
      if (!active.has(batch.batchId) || area.#batches.has(batch.batchId))
        throw new Error('Canonical batch 身份无效')
      area.#batches.set(batch.batchId, copy(batch.metadata))
    }
    if (area.digest() !== snapshot.digest)
      throw new Error('Canonical 快照指纹不匹配')
    return area
  }
  get revision(): number { return this.#revision }
  get entries(): MessageEntry[] { return copy(this.#entries) }
  get messages(): CanonicalMessage[] { return this.#entries.map(entry => copy(entry.message)) }
  get fixedPrefixSize(): number { return this.#prefix.length }
  get requestPrefix(): CanonicalMessage[] { return copy(this.#prefix) }
  get dynamicTail(): CanonicalMessage[] { return copy(this.#dynamicTail) }
  digest(): string { return this.services.digest(this.#entries.map(entry => ({ sequence: entry.sequence, message: entry.message }))) }
  snapshot(): CanonicalAreaSnapshot {
    const checkpoint = {
      entries: this.entries, revision: this.#revision, digest: this.digest(),
      batches: [...this.#batches].map(([batchId, metadata]) => ({ batchId, metadata: copy(metadata) }))
    }
    return { ...checkpoint, checkpointDigest: this.services.digest(checkpoint) }
  }
  configureRequest(prefix: readonly CanonicalMessage[]): void { this.#prefix = copy([...prefix]) }
  setDynamicTail(messages: readonly CanonicalMessage[]): void { this.#dynamicTail = copy([...messages]) }
  identity(modelIdentity: string): ProjectionIdentity {
    return {
      areaRevision: this.#revision, areaDigest: this.digest(), entryCount: this.#entries.length,
      prefixDigest: this.services.digest(this.#prefix), modelIdentity
    }
  }
  matchesProjection(projection: ProjectionIdentity, modelIdentity: string): boolean {
    return stableJson(projectionIdentity(projection)) === stableJson(this.identity(modelIdentity))
  }
  project<Wire>(port: ProviderProjectionPort<Wire>, modelIdentity: string): OpaqueProviderProjection<Wire> {
    const projection = port.project({ snapshot: this.snapshot(), prefix: this.requestPrefix, dynamicTail: this.dynamicTail, modelIdentity })
    if (!this.matchesProjection(projection, modelIdentity) || projection.dynamicTailSize !== this.#dynamicTail.length)
      throw new Error('Provider projection 身份或边界不匹配')
    return copy(projection)
  }
  append(message: CanonicalMessage, options: Omit<EntryInput, 'message'> = {}): MessageEntry {
    return this.appendBatch([{ message, ...options }])[0]!
  }
  appendBatch(inputs: readonly EntryInput[], metadata?: Record<string, Json>): MessageEntry[] {
    // 先完成全部规范化，非法输入不能让 revision 或序号只推进一半。
    const values = inputs.map(input => {
      assertCanonicalInput(input.message)
      return { ...copy(input), message: canonicalizeMessage(input.message) }
    })
    if (!values.length)
      return []
    const batchId = metadata ? this.services.nextId() : null
    const revision = this.#revision + 1
    const entries: MessageEntry[] = values.map((input, index) => ({
      ...input,
      entryId: this.services.nextId(), sequence: this.#nextSequence + index, revision,
      source: input.source ?? 'unknown', persistencePolicy: input.persistencePolicy ?? 'request_only',
      batchId: input.batchId ?? batchId
    }))
    this.#entries.push(...entries)
    this.#nextSequence += entries.length
    this.#revision = revision
    if (batchId && metadata)
      this.#batches.set(batchId, copy(metadata))
    return copy(entries)
  }
  reviseEntry(entryId: string, message: CanonicalMessage, expectedRevision: number): MessageEntry {
    this.#assertRevision(expectedRevision)
    assertCanonicalInput(message)
    const index = this.#entries.findIndex(entry => entry.entryId === entryId)
    if (index < 0)
      throw new Error('Canonical entry 不存在')
    const normalized = canonicalizeMessage(message)
    const result = { ...this.#entries[index]!, message: normalized, revision: this.#revision + 1 }
    this.#entries[index] = result
    this.#revision++
    return copy(result)
  }
  resolveToolResult(entryId: string, result: Json, toolCallId?: string): MessageEntry {
    const entry = this.#entries.find(item => item.entryId === entryId)
    if (!entry)
      throw new Error('Canonical entry 不存在')
    const message = copy(entry.message)
    const matching = blocks(message.content).filter(block => block.type === 'tool_result' && (!toolCallId || (block.tool_call_id || block.tool_use_id) === toolCallId))
    if (message.role !== 'user' || matching.length !== 1)
      throw new Error('待恢复工具结果必须唯一匹配')
    matching[0]!.content = JSON.stringify(result)
    return this.reviseEntry(entryId, message, this.#revision)
  }
  replaceBaseline(messages: readonly CanonicalMessage[], expectedRevision: number): void {
    this.#assertRevision(expectedRevision)
    const normalized = messages.map(canonicalizeMessage)
    if (stableJson(normalized) === stableJson(this.messages))
      return
    const available = new Map<string, MessageEntry[]>()
    for (const entry of this.#entries) {
      const key = stableJson(entry.message), matches = available.get(key) ?? []
      matches.push(entry)
      available.set(key, matches)
    }
    const revision = this.#revision + 1
    this.#entries = normalized.map((message, sequence) => {
      const old = available.get(stableJson(message))?.shift()
      return old ? { ...old, message, sequence, revision } : { entryId: this.services.nextId(), sequence, revision, message, source: 'unknown', persistencePolicy: 'request_only' }
    })
    this.#nextSequence = this.#entries.length
    this.#revision = revision
    const active = new Set(this.#entries.map(entry => entry.batchId))
    for (const key of this.#batches.keys())
      if (!active.has(key))
        this.#batches.delete(key)
  }
  persistenceDelta(outcome: 'success' | 'interruption' | 'failure'): PersistenceDelta {
    const allowed = outcome === 'success' ? new Set(['commit_on_success']) : outcome === 'interruption'
      ? new Set(['commit_on_success', 'commit_on_interruption']) : new Set<string>()
    const entries = this.#entries.filter(entry => allowed.has(entry.persistencePolicy))
    const grouped = new Map<string, MessageEntry[]>()
    for (const entry of entries)
      if (entry.batchId) {
        const group = grouped.get(entry.batchId) ?? []
        group.push(entry)
        grouped.set(entry.batchId, group)
      }
    const batches = [...grouped].map(([batchId, batchEntries]) => {
      const metadata = this.#batches.get(batchId) ?? {}
      return {
        batchId, entries: copy(batchEntries), metadata: copy(metadata),
        digest: this.services.digest({ messages: batchEntries.map(entry => entry.message), metadata })
      }
    })
    const anchor = [...this.#entries].reverse().find(entry => entry.persistedMessageId != null && ['user', 'reference', 'attachment'].includes(entry.source))
    return {
      entries: copy(entries), revision: this.#revision,
      digest: this.services.digest(entries.map(entry => ({ sequence: entry.sequence, message: entry.message }))),
      batches, userAnchorSequence: anchor?.sequence ?? null
    }
  }
  #assertRevision(expectedRevision: number): void {
    if (expectedRevision !== this.#revision)
      throw new Error('MessageArea revision 已变化，拒绝覆盖')
  }
}

export function assertCanonicalInput(message: CanonicalMessage): void {
  if (!message || typeof message !== 'object' || typeof message.role !== 'string'
    || typeof message.content !== 'string' && !Array.isArray(message.content))
    throw new Error('Canonical批次消息必须有role和字符串或block列表content')
  if (Array.isArray(message.content)) {
    const allowed = new Set([...mediaTypes, 'text', 'attachment_ref', 'tool_call', 'tool_result', 'tool-schema', 'skill-schema', 'tool-discovery',
      'knowledge-context', 'stance-context', 'time-context', 'runtime-context'])
    if (message.content.some(value => !value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string' || !allowed.has(value.type)))
      throw new Error('Canonical批次block必须有受支持的type')
  }
  if (message.role === 'tool' || 'tool_calls' in message || 'reasoning_content' in message
    || blocks(message.content).some(block => ['tool_use', 'thinking', 'redacted_thinking', 'reasoning_content'].includes(block.type))) {
    throw new Error('新增Canonical批次不得接收Provider wire或私有推理')
  }
}

export function projectionIdentity(value: ProjectionIdentity): ProjectionIdentity {
  return {
    areaRevision: value.areaRevision, areaDigest: value.areaDigest, entryCount: value.entryCount,
    prefixDigest: value.prefixDigest, modelIdentity: value.modelIdentity
  }
}

export function copy<T>(value: T): T { return structuredClone(value) }

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value)
  if (Array.isArray(value))
    return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .filter(([, item]) => item !== undefined).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}

export function blocks(value: Json | undefined): Block[] {
  const values = Array.isArray(value) ? value : [value]
  return values.filter((item): item is Block => !!item && typeof item === 'object' && !Array.isArray(item) && typeof item.type === 'string')
}

export const mediaTypes = new Set(['image', 'image_url', 'input_image', 'input_audio', 'audio', 'video', 'video_url', 'file'])

export const knownTypes = new Set(['text', 'quote', 'attachment_ref', 'transcript', 'attachment_text',
  'tool_call', 'tool_use', 'tool_result', 'tool-schema', 'skill-schema', 'tool-discovery',
  'knowledge-context', 'stance-context', 'time-context', 'runtime-context', 'interaction_request',
  'interaction_result', 'thinking', 'reasoning_content'])

export function isLegacyTimeText(value: unknown): boolean {
  return typeof value === 'string' && /^\[system-reminder\]\n(?:当前时间：)?[^\n]+\n\[\/system-reminder\]$/.test(value)
}

export function normalizeHistoryMessage(message: Record<string, Json | undefined>, source?: string): HistoryEnvelope {
  const role = String(message.role || 'user')
  let raw = message.content_json
  if (raw == null)
    raw = role === 'tool'
      ? [{ type: 'tool_result', tool_call_id: message.tool_call_id ?? message.tool_use_id ?? null, content: message.content ?? '' }]
      : message.content ? [{ type: 'text', text: String(message.content) }] : []
  const values = Array.isArray(raw) ? raw : [raw]
  let unknownBlockCount = 0
  const contentBlocks = values.map((value): Block => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      unknownBlockCount++
      return { type: 'text', text: String(value) }
    }
    const type = String(value.type || 'text')
    if (!knownTypes.has(type)) {
      unknownBlockCount++
      return { type: 'text', text: stableJson(value), source_type: type }
    }
    if (role === 'user' && type === 'text' && isLegacyTimeText(value.text))
      return { type: 'time-context', text: value.text! }
    return copy(value) as Block
  })
  const rawAttachments = message.files || message.attachments || []
  const attachments: Block[] = []
  for (const value of Array.isArray(rawAttachments) ? rawAttachments : [rawAttachments]) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      continue
    const id = value.attach_id || value.id || value.file_id
    if (!id)
      continue
    const ref: Block = { type: 'attachment_ref', attach_id: String(id) }
    for (const key of ['kind', 'mime', 'ext', 'title', 'name', 'size_bytes'])
      if (value[key] != null)
        ref[key] = copy(value[key])
    attachments.push(ref)
  }
  return {
    schemaVersion: 1, role, contentBlocks, attachments,
    quote: message.quoted_text ? { type: 'quote', text: String(message.quoted_text) } : null,
    sender: message.platform_user_id || message.platform_user_name ? {
      id: message.platform_user_id ? String(message.platform_user_id) : null,
      name: message.platform_user_name ? String(message.platform_user_name) : null,
    } : null, sentAt: message.sent_at ? String(message.sent_at).trim() || null : null,
    source: source || (message.source ? String(message.source) : null), unknownBlockCount
  }
}

export function toolCallIds(message: CanonicalMessage): Set<string> {
  const ids = new Set<string>()
  if (Array.isArray(message.tool_calls))
    for (const call of message.tool_calls) {
      if (call && typeof call === 'object' && !Array.isArray(call) && call.id)
        ids.add(String(call.id))
    }
  for (const block of blocks(message.content))
    if (block.type === 'tool_call' || block.type === 'tool_use') {
      const id = block.id || block.tool_call_id || block.tool_use_id
      if (id)
        ids.add(String(id))
    }
  return ids
}

export function toolResultIds(message: CanonicalMessage): Set<string> {
  const ids = new Set<string>()
  if (message.role === 'tool' && message.tool_call_id)
    ids.add(String(message.tool_call_id))
  for (const block of blocks(message.content))
    if (block.type === 'tool_result') {
      const id = block.tool_call_id || block.tool_use_id
      if (id)
        ids.add(String(id))
    }
  return ids
}

/** 完整历史摘要包裹或持久summary角色才是摘要；用户正文提及标记不能改变其身份。 */
export function isCompactedSummaryMessage(message: CanonicalMessage): boolean {
  if (message.role === 'summary')
    return true
  let text: string
  if (typeof message.content === 'string')
    text = message.content
  else if (Array.isArray(message.content) && message.content.every(value => value && typeof value === 'object' && !Array.isArray(value) && value.type === 'text'))
    text = blocks(message.content).map(block => String(block.text ?? '')).join('\n')
  else
    return false
  text = text.trim().replace(/^【消息时间】[^\n]*\n【消息正文】\n|^【消息正文】\n/, '').trim()
  return text.startsWith('<compacted-summary>') && text.endsWith('</compacted-summary>')
}

/** 与 Python budget.atomic_message_units 相同，连续结果必须和调用同进同出。 */
export function atomicMessageUnits(messages: readonly CanonicalMessage[]): number[][] {
  const units: number[][] = []
  for (let index = 0;index < messages.length;) {
    const unit = [index]
    const hasCall = toolCallIds(messages[index]!).size > 0
    index++
    if (hasCall)
      while (index < messages.length && (messages[index]!.role === 'tool' || toolResultIds(messages[index]!).size > 0))
        unit.push(index++)
    units.push(unit)
  }
  return units
}

export function groupHistoryUnits(messages: readonly CanonicalMessage[]): {
  kind: 'message' | 'tool_turn'
  messages: CanonicalMessage[]
}[] {
  const result: {
    kind: 'message' | 'tool_turn'
    messages: CanonicalMessage[]
  }[] = []
  for (let index = 0;index < messages.length;index++) {
    const current = messages[index]!, next = messages[index + 1]
    if (next && [...toolCallIds(current)].some(id => toolResultIds(next).has(id))) {
      result.push({ kind: 'tool_turn', messages: copy([current, next]) })
      index++
    }
    else
      result.push({ kind: 'message', messages: [copy(current)] })
  }
  return result
}

/** 私有推理不进入 Canonical；原始工具参数字符串保留字节形状。 */
export function canonicalizeMessage(message: CanonicalMessage): CanonicalMessage {
  const result = copy(message)
  if (result.role === 'tool' && blocks(result.content).some(block => block.type === 'tool_result'))
    return {
      role: 'user', content: blocks(result.content).map(block => block.type === 'tool_result'
        ? { ...block, tool_call_id: String(block.tool_call_id || block.tool_use_id || result.tool_call_id || ''), ...(toolResultBlockIsError(block) ? { is_error: true } : {}) } : block)
    }
  if (result.role === 'tool')
    return {
      role: 'user', content: [{
        type: 'tool_result', tool_call_id: String(result.tool_call_id || ''), content: result.content,
        ...(toolResultBlockIsError(result) ? { is_error: true } : {})
      }]
    }
  const normalized: Block[] = []
  if (result.role === 'assistant' && Array.isArray(result.tool_calls)) {
    if (typeof result.content === 'string' && result.content)
      normalized.push({ type: 'text', text: result.content })
    for (const call of result.tool_calls) {
      if (!call || typeof call !== 'object' || Array.isArray(call))
        continue
      const fn = call.function && typeof call.function === 'object' && !Array.isArray(call.function) ? call.function : {}
      normalized.push({ type: 'tool_call', id: String(call.id || 'tool-call'), name: String(fn.name || 'unknown_tool'), arguments: fn.arguments ?? '{}' })
    }
    return { role: result.role, content: normalized }
  }
  if (Array.isArray(result.content))
    result.content = blocks(result.content)
      .filter(block => !['thinking', 'redacted_thinking', 'reasoning_content'].includes(block.type))
      .map(block => block.type === 'tool_use' ? { type: 'tool_call', id: String(block.id || block.tool_use_id || 'tool-call'), name: String(block.name || 'unknown_tool'), arguments: block.arguments ?? block.input ?? {} }
        : block.type === 'tool_result' ? { ...block, tool_call_id: String(block.tool_call_id || block.tool_use_id || ''), ...(toolResultBlockIsError(block) ? { is_error: true } : {}) } : block)
  delete result.reasoning_content
  return result
}

export function toolResultBlockIsError(block: Record<string, Json>): boolean {
  if ('is_error' in block)
    return !!block.is_error
  const values = Array.isArray(block.content) ? block.content : [block.content]
  return values.some(value => {
    if (value && typeof value === 'object' && !Array.isArray(value))
      return !!value.error
    if (typeof value !== 'string')
      return false
    try {
      const parsed = JSON.parse(value) as Json
      return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !!parsed.error
    }
    catch {
      return false
    }
  })
}

export function buildCanonicalContext(input: {
  fixedParts: readonly CanonicalMessage[]
  history: readonly CanonicalMessage[]
  currentTurn?: readonly CanonicalMessage[]
  systemText?: string
}): CanonicalContext {
  const fixed = copy([...input.fixedParts]), staticSystem = fixed.filter(message => message.role === 'system'
    && !(typeof message.content === 'string' && message.content.startsWith('[system-reminder]')))
  const sessionSnapshot = fixed.filter(message => !staticSystem.includes(message))
  if (input.systemText && !staticSystem.some(message => message.content === input.systemText))
    staticSystem.unshift({ role: 'system', content: input.systemText })
  return { staticSystem, sessionSnapshot, canonicalHistory: copy([...input.history]), currentTurn: copy([...(input.currentTurn ?? [])]), historyUnits: groupHistoryUnits(input.history) }
}

/** 诊断只返回结构和不可逆指纹，不能把正文放入可见trace。 */
export function contextDiagnostics(context: CanonicalContext, services: ContextServices): {
  canonicalDigest: string
  sectionDigests: Record<string, string>
  sectionCounts: Record<string, number>
  historyUnitCount: number
  toolTurnCount: number
} {
  const sections = {
    staticSystem: context.staticSystem, sessionSnapshot: context.sessionSnapshot,
    canonicalHistory: context.canonicalHistory, currentTurn: context.currentTurn
  }
  const sectionDigests = Object.fromEntries(Object.entries(sections).map(([key, value]) => [key, services.digest(value)]))
  return {
    canonicalDigest: services.digest(sectionDigests), sectionDigests,
    sectionCounts: Object.fromEntries(Object.entries(sections).map(([key, value]) => [key, value.length])),
    historyUnitCount: context.historyUnits.length, toolTurnCount: context.historyUnits.filter(unit => unit.kind === 'tool_turn').length
  }
}

export function eventKey(block: Block): string {
  return stableJson([block.type, block.tool_name ?? null, block.schema_digest ?? null, block.implementation_digest ?? null, block.skill_name ?? null])
}

export function validateEvent(block: Block): void {
  if (!['tool-schema', 'skill-schema', 'tool-discovery'].includes(block.type))
    throw new Error('工具只允许声明Schema、Skill或Discovery事件')
  if (block.type === 'tool-schema' && (typeof block.tool_name !== 'string' || !block.tool_name || typeof block.schema_digest !== 'string' || !block.schema_digest
    || !block.schema || typeof block.schema !== 'object' || Array.isArray(block.schema)))
    throw new Error('工具Schema事件缺少稳定身份或schema')
  if (block.type === 'skill-schema' && (typeof block.skill_name !== 'string' || !block.skill_name))
    throw new Error('Skill事件身份无效')
  if (block.type !== 'tool-schema' && (!Array.isArray(block.tool_names) || block.tool_names.some(name => typeof name !== 'string' || !name)))
    throw new Error('工具声明名称列表无效')
}

/** 事件来自可信Tools registry输出，不接受Provider自行声明权限。与同轮工具结果同batch但独立user边界。 */
export function appendCanonicalEvents(area: MessageArea, events: readonly Block[], options: {
  roundId?: string
  batchId?: string
  persistencePolicy?: PersistencePolicy
} = {}): MessageEntry[] {
  for (const event of events)
    validateEvent(event)
  const history = area.messages, accepted: CanonicalMessage[] = []
  for (const event of events) {
    const candidates = [...history, ...accepted].flatMap(message => blocks(message.content))
    const previous = event.type === 'tool-schema' ? [...candidates].reverse().find(block => block.type === 'tool-schema' && block.tool_name === event.tool_name) : null
    if (event.type === 'tool-schema' ? previous && previous.schema_digest === event.schema_digest && (previous.implementation_digest ?? '') === (event.implementation_digest ?? '')
      : candidates.some(block => eventKey(block) === eventKey(event)))
      continue
    accepted.push({ role: 'user', content: [copy(event)] })
  }
  return area.appendBatch(accepted.map(message => ({
    message, source: 'tool_round', persistencePolicy: options.persistencePolicy ?? 'commit_on_success',
    roundId: options.roundId, batchId: options.batchId
  })))
}

export function toolSchemaDigest(schema: Json, services: ContextServices): string { return services.digest(schema) }

/** 模型相关schema改变只对本请求追加新契约，不改写旧调用或重解释历史参数。 */
export function refreshCanonicalToolSchemas(area: MessageArea, latestEvents: readonly Block[]): MessageEntry[] {
  for (const event of latestEvents) {
    validateEvent(event)
    if (event.type !== 'tool-schema')
      throw new Error('Schema刷新只接受tool-schema')
  }
  const history = area.messages.flatMap(message => blocks(message.content))
  const messages: CanonicalMessage[] = []
  for (const event of latestEvents) {
    const previous = [...history].reverse().find(block => block.type === 'tool-schema' && block.tool_name === event.tool_name)
    if (!previous || previous.schema_digest === event.schema_digest && (previous.implementation_digest ?? '') === (event.implementation_digest ?? ''))
      continue
    messages.push({ role: 'user', content: [{ type: 'text', text: '当前请求使用下面的最新工具参数契约；更早的同名 Schema 仅用于解释历史调用。' }, copy(event)] })
    history.push(copy(event))
  }
  return area.appendBatch(messages.map(message => ({ message, source: 'runtime', persistencePolicy: 'request_only' })))
}

export function canonicalEventStats(messages: readonly CanonicalMessage[]): {
  count: number
  byType: Record<string, number>
  schemaDigests: string[]
} {
  const types = new Set(['tool_call', 'tool_result', 'tool-schema', 'skill-schema', 'tool-discovery', 'knowledge-context', 'stance-context', 'time-context', 'runtime-context'])
  const byType: Record<string, number> = {}, digests = new Set<string>()
  let count = 0
  for (const message of messages)
    for (const block of blocks(message.content))
      if (types.has(block.type)) {
        count++
        byType[block.type] = (byType[block.type] ?? 0) + 1
        if (typeof block.schema_digest === 'string' && block.schema_digest)
          digests.add(block.schema_digest)
      }
  return { count, byType: Object.fromEntries(Object.entries(byType).sort(([left], [right]) => left < right ? -1 : 1)), schemaDigests: [...digests].sort() }
}

/** 只生成Provider-neutral text块，协议角色转换仍由Provider adapter负责；不重排事件。 */
export function renderCanonicalEvents(messages: readonly CanonicalMessage[]): CanonicalMessage[] {
  return messages.map(message => {
    if (!Array.isArray(message.content))
      return copy(message)
    const content = blocks(message.content).map(block => {
      const cleaned = Object.fromEntries(Object.entries(block).filter(([, value]) => value != null)) as Block
      let text: string | null = null
      if (cleaned.type === 'tool-schema')
        text = `[canonical tool-schema]\n工具名：${cleaned.tool_name ?? ''}\n版本：${cleaned.schema_version ?? 1}\nSchema：${stableJson(cleaned.schema ?? {})}`
      else if (cleaned.type === 'skill-schema')
        text = `[canonical skill-schema]\n技能：${cleaned.skill_name ?? ''}\n关联工具：${Array.isArray(cleaned.tool_names) ? cleaned.tool_names.join(', ') : ''}`
      else if (cleaned.type === 'tool-discovery')
        text = `[canonical tool-discovery]\n可用工具：${Array.isArray(cleaned.tool_names) ? cleaned.tool_names.join(', ') : ''}`
      else if (['knowledge-context', 'stance-context', 'time-context', 'runtime-context'].includes(cleaned.type))
        text = String(cleaned.text ?? '')
      return text != null ? { type: 'text', text } : cleaned
    })
    return { ...copy(message), content }
  })
}

/** 只用于历史/诊断副本，不改真实dispatch参数；无header变更时保留原始JSON字节串。 */
export function redactToolRequestHeaders(value: Json): Json {
  if (typeof value === 'string') {
    let parsed: Json
    try {
      parsed = JSON.parse(value) as Json
    }
    catch {
      return /(?:"headers"|'headers'|headers)\s*:/i.test(value) ? '[请求参数已隐藏]' : value
    }
    const redacted = redactToolRequestHeaders(parsed)
    return redacted === parsed ? value : JSON.stringify(redacted)
  }
  if (Array.isArray(value)) {
    const result = value.map(redactToolRequestHeaders)
    return result.some((item, index) => item !== value[index]) ? result : value
  }
  if (!value || typeof value !== 'object')
    return value
  let changed = false
  const result: Record<string, Json> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key.toLowerCase() === 'headers') {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        result[key] = Object.fromEntries(Object.keys(item).map(name => [name, '[已隐藏]']))
        changed ||= Object.values(item).some(header => header !== '[已隐藏]')
      }
      else {
        result[key] = '[已隐藏]'
        changed ||= item !== '[已隐藏]'
      }
    }
    else {
      result[key] = redactToolRequestHeaders(item)
      changed ||= result[key] !== item
    }
  }
  return changed ? result : value
}

export function toolResultIsError(value: Json): boolean {
  const values = Array.isArray(value) ? value : [value]
  for (const item of values) {
    if (item && typeof item === 'object' && !Array.isArray(item) && item.error)
      return true
    if (typeof item === 'string') {
      try {
        const parsed = JSON.parse(item) as Json
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.error)
          return true
      }
      catch { /* 普通工具文本不是JSON错误对象。 */ }
    }
  }
  return false
}

/** 只有实际dispatch过的调用进入同批历史；确认等待前尚未执行的后续调用不得成为孤儿。 */
export function canonicalToolRound(input: {
  text: string
  calls: readonly CanonicalToolCall[]
  dispatched: readonly {
    callId: string
    content: Json
    isError?: boolean
    toolName?: string
  }[]
}): CanonicalMessage[] {
  const ids = new Set(input.dispatched.map(result => result.callId))
  if (ids.size !== input.dispatched.length)
    throw new Error('工具回执调用身份重复')
  const calls = input.calls.filter(call => ids.has(call.id) && call.id && call.name)
  if (calls.length !== ids.size)
    throw new Error('工具回执没有对应的调用声明')
  const assistant: Json[] = input.text ? [{ type: 'text', text: input.text }] : []
  for (const call of calls)
    assistant.push({
      type: 'tool_call', id: call.id, name: call.name,
      arguments: redactToolRequestHeaders(call.rawArguments ?? copy(call.input)), ...(call.responsesItemId ? { responses_item_id: call.responsesItemId } : {})
    })
  const results: Json[] = input.dispatched.map(result => ({
    type: 'tool_result', tool_call_id: result.callId,
    content: copy(result.content), ...(result.isError ?? toolResultIsError(result.content) ? { is_error: true } : {}), ...(result.toolName ? { tool_name: result.toolName } : {})
  }))
  return [...(assistant.length ? [{ role: 'assistant', content: assistant }] : []), ...(results.length ? [{ role: 'user', content: results }] : [])]
}

/** 严格JSON值快照：不调用getter、不接受平台对象或循环值，不共享可变Provider引用。 */
export function portableSnapshot(value: unknown): PortableValue {
  const visiting = new Set<object>()
  function visit(input: unknown): PortableValue {
    if (input === null || typeof input === 'string' || typeof input === 'boolean')
      return input
    if (typeof input === 'number' && Number.isFinite(input))
      return input
    if (!input || typeof input !== 'object' || visiting.has(input))
      throw new HarnessError('invalid_state', '工具参数不是可持久化JSON值')
    if (!Array.isArray(input) && ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
      throw new HarnessError('invalid_state', '工具参数含平台对象')
    if (Object.getOwnPropertySymbols(input).length)
      throw new HarnessError('invalid_state', '工具参数含不可持久化字段')
    visiting.add(input)
    try {
      if (Array.isArray(input)) {
        const result: PortableValue[] = []
        for (let index = 0;index < input.length;index++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
          if (!descriptor || !('value' in descriptor))
            throw new HarnessError('invalid_state', '工具参数含稀疏项或访问器')
          result.push(visit(descriptor.value))
        }
        return Object.freeze(result)
      }
      const result: Record<string, PortableValue> = Object.create(null) as Record<string, PortableValue>
      for (const name of Object.keys(input).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(input, name)!
        if (!('value' in descriptor))
          throw new HarnessError('invalid_state', '工具参数含访问器')
        result[name] = visit(descriptor.value)
      }
      return Object.freeze(result)
    }
    finally {
      visiting.delete(input)
    }
  }
  return visit(value)
}

export function snapshotToolCall(call: ToolCall): ToolCall {
  if (!call || typeof call.id !== 'string' || !call.id || typeof call.name !== 'string' || !call.name)
    throw new HarnessError('invalid_state', '工具调用身份无效')
  if ((call.rawArguments !== undefined && typeof call.rawArguments !== 'string') || (call.responsesItemId !== undefined && typeof call.responsesItemId !== 'string'))
    throw new HarnessError('invalid_state', '工具调用原始元数据无效')
  return Object.freeze({
    id: call.id, name: call.name, input: portableSnapshot(call.input),
    ...(call.rawArguments === undefined ? {} : { rawArguments: call.rawArguments }),
    ...(call.responsesItemId === undefined ? {} : { responsesItemId: call.responsesItemId }),
  })
}

export function sameToolCall(left: ToolCall, right: ToolCall): boolean {
  // 确认目标依语义参数匹配；确认服务不能覆盖已接受原调用的raw/wire身份。
  return left.id === right.id && left.name === right.name && JSON.stringify(portableSnapshot(left.input)) === JSON.stringify(portableSnapshot(right.input))
}



export function snapshotInteraction(request: PendingInteraction, call: ToolCall): PendingInteraction {
  if (!request || typeof request.id !== 'string' || !request.id || !['question', 'confirmation', 'credential'].includes(request.kind) || !sameToolCall(request.toolCall, call)) {
    throw new HarnessError('invalid_state', '交互与原工具调用不匹配')
  }
  return Object.freeze({ id: request.id, kind: request.kind, toolCall: snapshotToolCall(call), ...(request.afterConfirmation ? { afterConfirmation: true } : {}) })
}



/** 收据在等待之前深快照，Provider/Tools复用对象不能改变重启后的执行现场。 */
export function snapshotToolResult(result: ToolResult, call: ToolCall): ToolResult {
  if (result.kind === 'unknown')
    return Object.freeze({ kind: 'unknown' })
  if (result.kind === 'waiting')
    return Object.freeze({ kind: 'waiting', interaction: snapshotInteraction(result.interaction, call) })
  if (typeof result.successful !== 'boolean' || typeof result.mutated !== 'boolean' || (result.executed !== undefined && typeof result.executed !== 'boolean'))
    throw new HarnessError('invalid_state', '工具回执无效')
  return Object.freeze({
    kind: 'completed', value: portableSnapshot(result.value), successful: result.successful, mutated: result.mutated,
    ...(result.executed === undefined ? {} : { executed: result.executed }),
    ...(result.artifact === undefined ? {} : { artifact: portableSnapshot(result.artifact) }),
    ...(result.canonicalEvents === undefined ? {} : { canonicalEvents: Object.freeze(result.canonicalEvents.map(portableSnapshot)) }),
  })
}



/** Codec只能把结果载荷变成授权引用，不能改变执行/等待控制流。 */
export function sameToolResultControl(left: ToolResult, right: ToolResult): boolean {
  if (left.kind !== right.kind)
    return false
  if (left.kind === 'unknown')
    return true
  if (left.kind === 'waiting' && right.kind === 'waiting')
    return left.interaction.id === right.interaction.id && left.interaction.kind === right.interaction.kind && (left.interaction.afterConfirmation ?? false) === (right.interaction.afterConfirmation ?? false) && sameToolCall(left.interaction.toolCall, right.interaction.toolCall)
  return left.kind === 'completed' && right.kind === 'completed' && left.successful === right.successful && left.mutated === right.mutated && left.executed === right.executed
    && (left.artifact === undefined) === (right.artifact === undefined)
    && JSON.stringify(left.canonicalEvents ?? []) === JSON.stringify(right.canonicalEvents ?? [])
}
