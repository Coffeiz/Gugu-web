
import type { BranchInput,BranchPolicy,BranchResult,CanonicalMessage,HistoryIdentity,Json,OpaqueProviderProjection,PersistedHistoryRow,ReflectionPreparationInput,ReflectionSnapshot } from '../contracts.js'
import type { MessageArea } from '../history/canonical-history.js'
import { blocks,copy,stableJson } from '../history/canonical-history.js'
import { historyOrderKey } from '../history/ordering.js'
import type { BranchPorts,CanonicalFinalizationPort,ContextServices,PassiveGroupTailPorts,ReflectionFinalizationPorts,ReflectionProjectionPort,ReflectionRecoveryPorts } from '../ports.js'
import { isContextOverflowError,shouldCompact } from './budget.js'

/** 仅供已通过owned-idle/租约门的恢复调用方使用；不会凭空追加主Run assistant回复。 */
export function buildRebuiltReflectionSnapshot<Wire>(input: HistoryIdentity & {
  modelIdentity: string
  accessScopeHash: string
  systemPrompt: string
  area: MessageArea
  projection: OpaqueProviderProjection<Wire>
  tools?: readonly Json[]
}, port: ReflectionProjectionPort<Wire>, services: ContextServices, now: number): ReflectionSnapshot<Wire> {
  if (!input.ownerId || !input.sessionId || !input.accessScopeHash || !input.area.matchesProjection(input.projection, input.modelIdentity))
    throw new Error('重建反思快照身份不匹配')
  const projection = port.append(copy(input.projection), [])
  if (projection.dynamicTailSize !== 0 || projection.modelIdentity !== input.modelIdentity)
    throw new Error('重建反思快照不能携带动态尾部或跨模型')
  const entries = input.area.entries
  const payload = {
    ownerId: input.ownerId, sessionId: input.sessionId, runId: 'idle', modelIdentity: input.modelIdentity,
    accessScopeHash: input.accessScopeHash, systemPrompt: input.systemPrompt, tools: copy([...(input.tools ?? [])]), projection,
    persistedMessageIds: [...new Set(entries.flatMap(entry => entry.persistedMessageId != null ? [entry.persistedMessageId] : []))],
    persistedPrefix: entries.flatMap(entry => entry.persistedMessageId != null ? [{
      id: entry.persistedMessageId,
      sequence: entry.sequence, messageDigest: services.digest(prefixComparableMessage(entry.message))
    }] : []),
    providerContextInput: null, providerCompacted: false, createdAt: now, source: 'persisted_history' as const
  }
  return { ...payload, digest: services.digest(payload) }
}

/** 仅进程内缓存；不提供序列化持久化接口，群/成员 sibling branch 共用原快照。 */
export class ReflectionSnapshots<Wire> {
  #values = new Map<string, ReflectionSnapshot<Wire>>();
  constructor(readonly services: ContextServices, readonly now: () => number, readonly ttlMs = 900000, readonly capacity = 64) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(capacity) || capacity <= 0)
      throw new Error('快照生命周期上限无效')
  }
  #key(identity: HistoryIdentity, accessScopeHash: string): string { return stableJson([identity.ownerId, identity.sessionId, accessScopeHash]) }
  capture(input: HistoryIdentity & {
    runId: string
    modelIdentity: string
    systemPrompt: string
    tools: Json[]
    area: MessageArea
    projection: OpaqueProviderProjection<Wire>
    replyText: string
    providerContextInput?: number | null
    providerCompacted?: boolean
    accessScopeHash?: string | null
  }, port: ReflectionProjectionPort<Wire>): ReflectionSnapshot<Wire> | null {
    if (!input.ownerId || !input.sessionId || !input.accessScopeHash || !input.replyText.trim() || !input.area.matchesProjection(input.projection, input.modelIdentity))
      return null
    const projection = port.append(copy(input.projection), [{ role: 'assistant', content: input.replyText }])
    if (projection.dynamicTailSize !== 0 || projection.modelIdentity !== input.modelIdentity)
      throw new Error('反思投影未清除动态尾部或模型身份不匹配')
    const payload = {
      ownerId: input.ownerId, sessionId: input.sessionId, runId: input.runId,
      modelIdentity: input.modelIdentity, accessScopeHash: input.accessScopeHash, systemPrompt: input.systemPrompt, tools: copy(input.tools), projection,
      persistedMessageIds: [...new Set(input.area.entries.flatMap(entry => entry.persistedMessageId != null ? [entry.persistedMessageId] : []))],
      persistedPrefix: input.area.entries.flatMap(entry => entry.persistedMessageId != null ? [{
        id: entry.persistedMessageId,
        sequence: entry.sequence, messageDigest: this.services.digest(prefixComparableMessage(entry.message))
      }] : []),
      providerContextInput: input.providerContextInput ?? null, providerCompacted: input.providerCompacted ?? false, createdAt: this.now(), source: 'in_memory' as const
    }
    const snapshot: ReflectionSnapshot<Wire> = { ...payload, digest: this.services.digest(payload) }
    const key = this.#key(input, input.accessScopeHash)
    this.#values.delete(key)
    this.#values.set(key, copy(snapshot))
    while (this.#values.size > this.capacity)
      this.#values.delete(this.#values.keys().next().value!)
    return copy(snapshot)
  }
  peek(identity: HistoryIdentity, modelIdentity: string, accessScopeHash?: string | null): ReflectionSnapshot<Wire> | null {
    if (!accessScopeHash)
      return null
    const key = this.#key(identity, accessScopeHash), value = this.#values.get(key)
    if (!value)
      return null
    if (this.now() - value.createdAt > this.ttlMs) {
      this.#values.delete(key)
      return null
    }
    if (value.modelIdentity !== modelIdentity)
      return null
    const { digest, ...payload } = value
    if (this.services.digest(payload) !== digest) {
      this.#values.delete(key)
      return null
    }
    this.#values.delete(key)
    this.#values.set(key, value)
    return copy(value)
  }
  discard(identity: HistoryIdentity, accessScopeHash?: string): void {
    if (accessScopeHash) {
      this.#values.delete(this.#key(identity, accessScopeHash))
      return
    }
    for (const [key, snapshot] of this.#values)
      if (snapshot.ownerId === identity.ownerId && snapshot.sessionId === identity.sessionId)
        this.#values.delete(key)
  }
}

/** 普通群反思没有快照时必须等待，不能静默从数据库重建；显式压力压缩允许重建。 */
export function reflectionRecoveryPolicy(scope: 'owner' | 'group' | 'member', hasSnapshot: boolean, reason: 'idle' | 'context-pressure' | 'compacted', ownerIdleRebuildAuthorized = false): 'reuse' | 'rebuild' | 'defer' {
  if (hasSnapshot)
    return 'reuse'
  return reason !== 'idle' || scope === 'owner' && ownerIdleRebuildAuthorized ? 'rebuild' : 'defer'
}

export function appendReflectionHistory<Wire>(snapshot: ReflectionSnapshot<Wire>, input: HistoryIdentity & {
  modelIdentity: string
  persistedPrefixIds: readonly string[]
  messages: readonly CanonicalMessage[]
  accessScopeHash?: string | null
  persistedPrefix: readonly {
    id: string
    sequence: number
    message: CanonicalMessage
  }[]
}, port: ReflectionProjectionPort<Wire>, services: ContextServices): OpaqueProviderProjection<Wire> {
  if (!input.accessScopeHash || input.accessScopeHash !== snapshot.accessScopeHash || input.ownerId !== snapshot.ownerId || input.sessionId !== snapshot.sessionId || input.modelIdentity !== snapshot.modelIdentity
    || stableJson(input.persistedPrefixIds) !== stableJson(snapshot.persistedMessageIds)
    || stableJson(input.persistedPrefix.map(entry => ({ id: entry.id, sequence: entry.sequence, messageDigest: services.digest(prefixComparableMessage(entry.message)) }))) !== stableJson(snapshot.persistedPrefix))
    throw new Error('反思前缀身份或持久化边界不匹配')
  return port.append(copy(snapshot.projection), copy(input.messages))
}

/** 纯文本字符串与单text块允许等价；工具、媒体与原生结构必须严格相等。 */
export function prefixComparableMessage(message: CanonicalMessage): {
  role: string
  content: Json
} {
  let content = copy(message.content)
  if (Array.isArray(content) && content.length === 1) {
    const block = content[0]
    if (block && typeof block === 'object' && !Array.isArray(block) && block.type === 'text'
      && Object.keys(block).every(key => ['type', 'text'].includes(key)))
      content = block.text ?? ''
  }
  return { role: message.role, content }
}

export function numericId(value: string): bigint | null { return /^\d+$/.test(value) ? BigInt(value) : null }

/** 复用主Run原始前缀，只追加可证明发生在其后的被动群消息。中间出现其他Run时等待新快照。 */
export async function extendGroupReflectionSnapshot<Wire>(snapshot: ReflectionSnapshot<Wire>, input: HistoryIdentity & {
  modelIdentity: string
  accessScopeHash?: string | null
  taskRows: readonly PersistedHistoryRow[]
  throughMessageId?: string | null
}, ports: PassiveGroupTailPorts<Wire>, services: ContextServices, signal?: AbortSignal): Promise<ReflectionSnapshot<Wire> | null> {
  signal?.throwIfAborted()
  if (!input.accessScopeHash || input.accessScopeHash !== snapshot.accessScopeHash || input.ownerId !== snapshot.ownerId || input.sessionId !== snapshot.sessionId || input.modelIdentity !== snapshot.modelIdentity)
    return null
  const { digest, ...payload } = snapshot
  if (services.digest(payload) !== digest)
    return null
  const ids = snapshot.persistedMessageIds.map(numericId)
  if (ids.some(id => id == null))
    return null
  const max = ids.reduce<bigint | null>((largest, id) => id != null && (largest == null || id > largest) ? id : largest, null)
  const covered = new Set(snapshot.persistedMessageIds)
  for (const row of input.taskRows) {
    if (row.ownerId !== input.ownerId || row.sessionId !== input.sessionId)
      return null
    if (covered.has(row.id) || row.runId === snapshot.runId)
      continue
    const id = numericId(row.id)
    if (row.runId != null || id == null || max == null || id <= max)
      return null
  }
  signal?.throwIfAborted()
  const owned = await ports.ownsGroupSession(input, signal)
  signal?.throwIfAborted()
  if (!owned)
    return null
  const tail = await ports.readTail(input, max?.toString() ?? null, input.throughMessageId ?? null, signal)
  signal?.throwIfAborted()
  const passive: PersistedHistoryRow[] = []
  const through = input.throughMessageId != null ? numericId(input.throughMessageId) : null
  if (input.throughMessageId != null && through == null)
    return null
  for (const row of tail) {
    const id = numericId(row.id)
    if (row.ownerId !== input.ownerId || row.sessionId !== input.sessionId || id == null || max != null && id <= max || through != null && id > through)
      return null
    if (row.runId === snapshot.runId)
      continue
    if (row.runId != null)
      return null
    if (row.role === 'user' && row.senderId != null)
      passive.push(copy(row))
  }
  if (!passive.length)
    return copy(snapshot)
  passive.sort((left, right) => {
    const a = historyOrderKey(left), b = historyOrderKey(right)
    for (let index = 0;index < a.length;index++)
      if (a[index]! < b[index]!)
        return -1
      else if (a[index]! > b[index]!)
        return 1
    return 0
  })
  const messages = await ports.renderTail(passive, input.modelIdentity, signal)
  signal?.throwIfAborted()
  const projection = ports.append(copy(snapshot.projection), copy(messages))
  if (projection.modelIdentity !== snapshot.modelIdentity || projection.dynamicTailSize !== 0)
    throw new Error('被动群消息追加改变了投影身份或动态边界')
  const updated = { ...payload, projection, providerContextInput: null, source: 'in_memory_extended' as const }
  return { ...copy(updated), digest: services.digest(updated) }
}

export function reflectionEligibility<Wire>(input: HistoryIdentity & {
  modelIdentity: string
  bufferedSessionIds: readonly (string | null)[]
  scope: 'owner' | 'group' | 'member'
  contextWindow: number
  reason: 'idle' | 'context-pressure' | 'compacted'
  ownerIdleRebuildAuthorized?: boolean
  accessScopeHash?: string | null
}, snapshot: ReflectionSnapshot<Wire> | null): {
  mode: 'reuse' | 'rebuild' | 'defer'
  reason: string
  compactBeforeReflection: boolean
} {
  if (!input.accessScopeHash)
    return { mode: 'defer', reason: 'access_scope_unavailable', compactBeforeReflection: false }
  if (snapshot && snapshot.accessScopeHash !== input.accessScopeHash)
    return { mode: 'defer', reason: 'access_scope_mismatch', compactBeforeReflection: false }
  let reason = 'eligible'
  if (!snapshot)
    reason = 'no_snapshot'
  else if (!input.bufferedSessionIds.length)
    reason = 'no_turns'
  else if (snapshot.ownerId !== input.ownerId || snapshot.sessionId !== input.sessionId)
    reason = 'session_mismatch'
  else if (input.bufferedSessionIds.some(id => id !== snapshot.sessionId))
    reason = 'buffer_spans_sessions'
  else if (input.modelIdentity !== snapshot.modelIdentity)
    reason = 'provider_switched'
  const usable = reason === 'eligible'
  return {
    mode: reflectionRecoveryPolicy(input.scope, usable, input.reason, input.ownerIdleRebuildAuthorized), reason,
    compactBeforeReflection: usable && !snapshot!.providerCompacted && shouldCompact(snapshot!.providerContextInput, input.contextWindow)
  }
}

/** Harness只编排资格、互斥与恢复；持久Job调度/重试队列不在这里实现。 */
export async function prepareReflectionSnapshot<Wire>(input: ReflectionPreparationInput, original: ReflectionSnapshot<Wire> | null, ports: ReflectionRecoveryPorts<Wire>, signal?: AbortSignal): Promise<{
  snapshot: ReflectionSnapshot<Wire> | null
  status: 'ready' | 'deferred' | 'blocked'
  reason: string
}> {
  signal?.throwIfAborted()
  const validTurns = input.bufferedSessionIds.length > 0 && input.bufferedSessionIds.every(id => id === input.sessionId)
  if (!validTurns)
    return { snapshot: null, status: 'deferred', reason: input.bufferedSessionIds.length ? 'buffer_spans_sessions' : 'no_turns' }
  const decision = reflectionEligibility({ ...input, ownerIdleRebuildAuthorized: input.allowOwnerIdleRebuild }, original)
  if (decision.mode === 'defer')
    return { snapshot: null, status: 'deferred', reason: decision.reason }
  if (decision.mode === 'reuse' && !decision.compactBeforeReflection)
    return { snapshot: copy(original), status: 'ready', reason: 'eligible' }
  const sessionOwnedAndIdle = async (): Promise<boolean> => {
    const session = await ports.readSession(input, signal)
    signal?.throwIfAborted()
    return session != null && session.ownerId === input.ownerId && session.sessionId === input.sessionId
      && session.executionState === 'idle' && session.pendingMessageCount === 0
      && session.accessScopeHash === input.accessScopeHash
  }
  signal?.throwIfAborted()
  if (!await sessionOwnedAndIdle())
    return { snapshot: null, status: 'deferred', reason: 'session_not_owned_idle' }
  const lease = await ports.acquire(input, signal)
  if (lease == null) {
    signal?.throwIfAborted()
    return { snapshot: null, status: 'deferred', reason: 'session_busy' }
  }
  try {
    signal?.throwIfAborted()
    if (!await sessionOwnedAndIdle())
      return { snapshot: null, status: 'deferred', reason: 'session_not_owned_idle' }
    signal?.throwIfAborted()
    if (decision.compactBeforeReflection && original) {
      const status = await ports.compactBaseline(input, copy(original), lease, signal)
      signal?.throwIfAborted()
      if (status === 'blocked')
        return { snapshot: null, status: 'blocked', reason: 'context_pressure' }
      if (status === 'not_needed')
        return { snapshot: copy(original), status: 'ready', reason: 'eligible' }
    }
    const snapshot = await ports.rebuild(input, input.modelIdentity, lease, input.accessScopeHash!, signal)
    signal?.throwIfAborted()
    if (!snapshot || snapshot.accessScopeHash !== input.accessScopeHash || snapshot.ownerId !== input.ownerId || snapshot.sessionId !== input.sessionId || snapshot.modelIdentity !== input.modelIdentity)
      return { snapshot: null, status: 'deferred', reason: 'rebuild_unavailable' }
    return { snapshot: copy(snapshot), status: 'ready', reason: 'persisted_history_rebuilt' }
  }
  finally {
    await ports.release(input, lease)
  }
}

/** 群聊owner长期记忆只能看到owner原文与本Run私人工具结果，不能吸收群聊助手回复。 */
export function buildOwnerReflectionInput(input: {
  ownerMessage: string
  groupChat: boolean
  reply: string
}, area: MessageArea): {
  userMessage: string
  assistantEvidence: string
} {
  if (!input.groupChat)
    return { userMessage: input.ownerMessage, assistantEvidence: input.reply }
  const results = area.entries.filter(entry => entry.source === 'tool_round').flatMap(entry => blocks(entry.message.content)
    .filter(block => block.type === 'tool_result').map(block => {
      const content = block.content
      if (typeof content === 'string')
        return content
      if (Array.isArray(content))
        return blocks(content).map(part => String(part.text || part.content || '')).filter(Boolean).join('\n')
      return content == null ? '' : String(content)
    })).filter(Boolean)
  return { userMessage: input.ownerMessage, assistantEvidence: results.join('\n\n') || '（只分析当前 owner 发言，不分析群聊助手回复）' }
}

export async function runContextBranch<Wire>(input: BranchInput<Wire>, policy: BranchPolicy, ports: BranchPorts<Wire>, signal?: AbortSignal): Promise<BranchResult> {
  const retries = policy.maxRetries ?? 0, mode = policy.outputMode ?? 'json'
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 8)
    throw new Error('分支重试次数超出范围')
  const limit = policy.maxOutputTokens ?? 800
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('分支输出预算无效')
  const result: BranchResult = {
    ok: false, output: null, reason: 'provider_error', attempts: 0, contextOverflow: false, providerErrorCode: null,
    inputFingerprint: ports.digest({ system: input.stableSystem, delta: input.delta, projection: input.projection ?? null, canonicalHistory: input.canonicalHistory ?? [] }),
    outputFingerprint: null, usage: null, metadata: {
      branch: policy.name, mode: 'append_reuse', scope: input.scope ?? '',
      scopeRevision: input.scopeRevision ?? null, sessionId: input.sessionId, runId: input.runId
    }
  }
  for (let attempt = 1;attempt <= retries + 1;attempt++) {
    signal?.throwIfAborted()
    if (attempt > 1)
      await ports.pauseBeforeRetry(attempt, signal)
    signal?.throwIfAborted()
    result.attempts = attempt
    let output: Json
    try {
      const response = await ports.provider.complete({
        ...copy(input), scenario: policy.name, outputMode: mode, maxOutputTokens: limit,
        cacheSingleflight: policy.name === 'reflection' && !!input.projection
      }, signal)
      signal?.throwIfAborted()
      output = response.output
      result.usage = copy(response.usage)
    }
    catch (error) {
      if (signal?.aborted)
        throw signal.reason
      result.reason = 'provider_error'
      result.contextOverflow = isContextOverflowError(error)
      result.providerErrorCode = ports.provider.isInputRejected(error) ? 'input_sensitive' : null
      ports.diagnostic(error, { branch: policy.name, runFingerprint: ports.digest(input.runId), attempt })
      if (result.providerErrorCode || result.contextOverflow && policy.name === 'compaction')
        break
      continue
    }
    let normalized: Json = output
    if (mode === 'json' && typeof normalized === 'string' && normalized.trim()) {
      try {
        normalized = JSON.parse(normalized) as Json
      }
      catch {
        normalized = output
      }
    }
    const empty = normalized == null || normalized === '' || !!normalized && typeof normalized === 'object' && !Array.isArray(normalized) && Object.keys(normalized).length === 0
    const valid = mode === 'text' ? typeof normalized === 'string' && !!normalized.trim()
      : normalized != null && typeof normalized === 'object' && !Array.isArray(normalized) && Object.keys(normalized).length > 0
    if (!valid) {
      result.reason = empty ? 'output_empty' : 'schema_invalid'
      continue
    }
    result.ok = true
    result.output = copy(normalized)
    result.outputFingerprint = ports.digest(normalized)
    result.reason = 'completed'
    break
  }
  return result
}

/** 成功收尾后捕获原主请求；群/成员共享同一快照，原始wire永不进入持久通知。 */
export function createReflectionFinalizer(ports: ReflectionFinalizationPorts): CanonicalFinalizationPort {
  return {
    async complete(input) {
      if (!input.text.trim())
        return
      const policy = await ports.policy(input.identity)
      if (!policy.enabled)
        return
      const snapshot = input.request && input.projection
        ? ports.snapshots.capture({
          ...input.identity, modelIdentity: input.modelIdentity,
          accessScopeHash: input.accessScopeHash,
          systemPrompt: input.requestSystemPrompt, tools: input.requestTools,
          area: input.request.area, projection: input.projection, replyText: input.text,
          providerContextInput: input.providerContextInput, providerCompacted: input.providerCompacted,
        }, ports.projection) : null
      await ports.notifyReady({
        identity: input.identity, accessScopeHash: input.accessScopeHash,
        scope: policy.scope, snapshotDigest: snapshot?.digest ?? null,
        recovery: snapshot !== null ? 'reuse' : 'defer', hadTools: input.hadTools
      })
    },
  }
}
