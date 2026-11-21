import { projectAgentToolBrief } from '../capabilities/brief.js'

import type { CanonicalMessage,CanonicalSourceLoaderResult,CapabilityCatalog,ContextData,ContextLoadPolicy,CurrentTurnSources,HistoryIdentity,Json,PreparationIdentity,PreparedToolDefinition,RunCapabilities,RunIdentity,SessionSnapshotState } from '../models.js'
import { AgentRunError,isEarlyExit } from '../models.js'
import { recordAgentObservation } from '../observation.js'
import type { AgentObservationPort } from '../observation.js'
import { copy,portableSnapshot,stableJson } from './history/canonical-history.js'
import { loadSessionHistory } from './history/ordering.js'
import type { CanonicalContextPorts,CanonicalRunPreparationPorts,CapabilityPreparationPorts,ContextDataPorts,ContextServices,ContextSourcePorts,PreparationPorts,SessionSnapshotPorts } from '../ports.js'
import { buildRunRagContext,currentRunQuery } from './assemble.js'

/** 权限策略由可信Host计算；受限群成员只能读取自己的scope记忆与时区，不能触碰owner域。 */
interface ContextSourceTrace {
  identity: RunIdentity
  observation?: AgentObservationPort
  now(): number
}

const contextSourceNames: Record<string, string> = {
  loadTimezone: 'DB · User timezone', loadProjects: 'DB · Projects', loadEvents: 'DB · Calendar events',
  loadNotes: 'DB · Recent notes', loadFilesOverview: 'DB · Files overview',
  loadStylePreferences: 'DB · Reply style preferences', loadImChannels: 'IM channel state',
  loadMemory: 'Memory retrieval', loadImMemory: 'Dynamic memory', loadKnowledge: 'Knowledge overview',
}

function loadContextSource<T extends Json>(trace: ContextSourceTrace | undefined, loader: string, input: Record<string, unknown>, load: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!trace?.observation)
    return load()
  const startedAt = trace.now()
  return load().then(value => {
    const endedAt = trace.now()
    recordAgentObservation(trace.observation, {
      identity: trace.identity, kind: 'context', name: contextSourceNames[loader] ?? loader,
      spanId: `${trace.identity.runId}:context-source:${loader}`, at: endedAt,
      startedAt, endedAt, durationMs: Math.max(0, endedAt - startedAt), status: 'success',
      input: { loader, ...input }, output: value,
      attributes: { context_source: loader, loader, ...(Array.isArray(value) || value && typeof value === 'object' ? { result_count: Array.isArray(value) ? value.length : Object.keys(value).length } : {}) },
    })
    return value
  }, error => {
    const endedAt = trace.now()
    recordAgentObservation(trace.observation, {
      identity: trace.identity, kind: 'context', name: contextSourceNames[loader] ?? loader,
      spanId: `${trace.identity.runId}:context-source:${loader}`, at: endedAt,
      startedAt, endedAt, durationMs: Math.max(0, endedAt - startedAt),
      status: signal?.aborted ? 'cancelled' : 'error', input: { loader, ...input }, output: {},
      attributes: { context_source: loader, loader, failure_reason: signal?.aborted ? 'aborted' : 'source_failed' },
    })
    throw error
  })
}

export async function loadContextData(identity: HistoryIdentity, policy: ContextLoadPolicy, ports: ContextDataPorts, signal?: AbortSignal, query = '', trace?: ContextSourceTrace): Promise<ContextData> {
  signal?.throwIfAborted()
  const read = <T extends Json>(loader: string, input: Record<string, unknown>, load: () => Promise<T>, sourceSignal = signal): Promise<T> =>
    loadContextSource(trace, loader, input, load, sourceSignal)
  const userTimezone = await read('loadTimezone', {}, () => ports.loadTimezone(identity, signal))
  signal?.throwIfAborted()
  if (!policy.loadOwnerContext) {
    const imMemory = await read('loadImMemory', {}, () => ports.loadImMemory(identity, signal))
    signal?.throwIfAborted()
    return { projects: [], userTimezone, events: [], notes: [], filesOverview: {}, stylePreferences: {}, memory: {}, imChannels: {}, imMemory: copy(imMemory), knowledge: [] }
  }
  const cancel = new AbortController()
  const abort = (): void => { cancel.abort(signal?.reason) }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted)
    cancel.abort(signal.reason)
  // 每个任务立即注册拒绝处理，再串行使用DB，避免异步辅助源先失败产生未处理拒绝。
  const start = <T>(operation: () => Promise<T>): Promise<{
    ok: true
    value: T
  } | {
    ok: false
    error: unknown
  }> => Promise.resolve().then(operation)
    .then(value => ({ ok: true as const, value }), error => { cancel.abort(error); return { ok: false as const, error } })
  const memory = policy.memoryEnabled ? start(() => read('loadMemory', { query }, () => ports.loadMemory(identity, cancel.signal, query), cancel.signal)) : Promise.resolve({ ok: true as const, value: {} })
  const imMemory = start(() => read('loadImMemory', {}, () => ports.loadImMemory(identity, cancel.signal), cancel.signal))
  const knowledge = start(() => read('loadKnowledge', {}, () => ports.loadKnowledge(identity, cancel.signal), cancel.signal))
  try {
    cancel.signal.throwIfAborted()
    const projects = await read('loadProjects', {}, () => ports.loadProjects(identity, cancel.signal), cancel.signal)
    cancel.signal.throwIfAborted()
    const events = await read('loadEvents', { timezone: userTimezone }, () => ports.loadEvents(identity, userTimezone, cancel.signal), cancel.signal)
    cancel.signal.throwIfAborted()
    const notes = await read('loadNotes', {}, () => ports.loadNotes(identity, cancel.signal), cancel.signal)
    cancel.signal.throwIfAborted()
    const filesOverview = await read('loadFilesOverview', {}, () => ports.loadFilesOverview(identity, cancel.signal), cancel.signal)
    cancel.signal.throwIfAborted()
    const stylePreferences = await read('loadStylePreferences', {}, () => ports.loadStylePreferences(identity, cancel.signal), cancel.signal)
    cancel.signal.throwIfAborted()
    const imChannels = await read('loadImChannels', {}, () => ports.loadImChannels(identity, cancel.signal), cancel.signal)
    const auxiliary = await Promise.all([memory, imMemory, knowledge])
    for (const result of auxiliary)
      if (!result.ok)
        throw result.error
    const [memoryResult, imResult, knowledgeResult] = auxiliary
    // 经过上方判定后仍显式窄化，避免把失败源当作空数据。
    if (!memoryResult!.ok || !imResult!.ok || !knowledgeResult!.ok)
      throw new Error('上下文辅助源读取失败')
    cancel.signal.throwIfAborted()
    return copy({
      projects, userTimezone, events, notes, filesOverview, stylePreferences,
      memory: memoryResult!.value, imChannels, imMemory: imResult!.value, knowledge: knowledgeResult!.value
    })
  }
  catch (error) {
    cancel.abort(error)
    await Promise.all([memory, imMemory, knowledge])
    throw error
  }
  finally {
    signal?.removeEventListener('abort', abort)
  }
}

/** Core内统一来源顺序：owned snapshot → 可信模型策略 → 快照hit/rebuild → 连续历史 → 当前输入。
 * RAG由prepareContext在相同有效历史与排他水位上构建一次，不在来源阶段重复召回。
 */
export function createCanonicalSourceLoader(ports: ContextSourcePorts, observation?: AgentObservationPort): {
  load(identity: RunIdentity, signal: AbortSignal): Promise<CanonicalSourceLoaderResult>
} {
  return { load: (identity, signal) => prepareRunContextSources(identity, ports, signal, observation) }
}

/** 供可信 Host 与来源加载器共用；scope key 不得包含凭据或明文隐私。 */
export function contextAccessScopeHash(identity: HistoryIdentity, selection: Pick<import('../models.js').ContextSourceSelection, 'groupChat' | 'contextScopeKey' | 'contextPolicy'>, digest: ContextServices['digest']): string {
  if (selection.groupChat && (!selection.contextScopeKey || !selection.contextScopeKey.trim()))
    throw new Error('群上下文需要可信actor作用域绑定')
  return digest({ owner_id: identity.ownerId, session_id: identity.sessionId, group_chat: selection.groupChat,
    scope_key: selection.contextScopeKey ?? 'owner', load_owner_context: selection.contextPolicy.loadOwnerContext, memory_enabled: selection.contextPolicy.memoryEnabled })
}

export async function prepareRunContextSources(identity: RunIdentity, ports: ContextSourcePorts, signal?: AbortSignal, observation?: AgentObservationPort): Promise<CanonicalSourceLoaderResult> {
  const scope = copy(identity)
  signal?.throwIfAborted()
  const original = await ports.readSnapshot(copy(scope), signal)
  if (!original || original.ownerId !== scope.ownerId || original.sessionId !== scope.sessionId)
    throw new Error('会话上下文不存在')
  validateSessionSnapshotState(original)
  const selection = await ports.select(copy(scope), signal)
  if (!selection.modelIdentity || !Number.isSafeInteger(selection.contextWindow) || selection.contextWindow < 1)
    throw new Error('模型上下文身份或预算无效')
  const accessScopeHash = contextAccessScopeHash(scope, selection, ports.digest)
  signal?.throwIfAborted()
  let currentTurnPromise: Promise<CurrentTurnSources> | null = null
  const readCurrentTurn = (requestSignal?: AbortSignal) => currentTurnPromise ??= (() => {
    const startedAt = ports.now()
    return ports.currentTurn(copy(scope), requestSignal ?? signal).then(value => {
      const endedAt = ports.now()
      recordAgentObservation(observation, {
        identity: scope, kind: 'context', name: 'Current message and attachment preparation',
        spanId: `${scope.runId}:current-message-preparation`, at: endedAt, startedAt, endedAt,
        durationMs: Math.max(0, endedAt - startedAt), status: 'success',
        output: {
          current_user_count: value.currentUsers?.length ?? (value.currentUser ? 1 : 0),
          current_users_in_history: value.currentUsersInHistory === true,
          has_query: typeof value.query === 'string' && value.query.length > 0,
        },
        attributes: { context_source: 'current_message_preparation' },
      })
      return value
    }, error => {
      const endedAt = ports.now()
      const cancelled = requestSignal?.aborted === true || signal?.aborted === true
      recordAgentObservation(observation, {
        identity: scope, kind: 'context', name: 'Current message and attachment preparation',
        spanId: `${scope.runId}:current-message-preparation`, at: endedAt, startedAt, endedAt,
        durationMs: Math.max(0, endedAt - startedAt), status: cancelled ? 'cancelled' : 'error',
        output: {}, attributes: { context_source: 'current_message_preparation', failure_reason: cancelled ? 'aborted' : 'materialization_failed' },
      })
      throw error
    })
  })()
  const snapshotStartedAt = ports.now()
  let snapshot: Awaited<ReturnType<typeof ensureSessionSnapshot>>
  try {
    snapshot = await ensureSessionSnapshot(scope, original, {
      digest: ports.digest, nextId: ports.nextId, now: ports.now,
      currentRevision: (_, requestSignal) => ports.currentRevision(copy(scope), requestSignal),
      loadContext: async (_, requestSignal) => {
        const current = await readCurrentTurn(requestSignal)
        requestSignal?.throwIfAborted()
        const data = await loadContextData(copy(scope), selection.contextPolicy, ports.data, requestSignal,
          current.currentUser?.rawText ?? current.query ?? '', { identity: scope, observation, now: ports.now })
        requestSignal?.throwIfAborted()
        const payload = ports.builder.buildSnapshot(copy(data), copy(selection), copy(scope))
        const assembledAt = ports.now()
        recordAgentObservation(observation, {
          identity: scope, kind: 'context', name: 'Context assembly & prompt',
          spanId: `${scope.runId}:context:snapshot-assembly`, at: assembledAt,
          startedAt: assembledAt, endedAt: assembledAt, durationMs: 0, status: 'success',
          input: {
            project_count: Array.isArray(data.projects) ? data.projects.length : 0,
            event_count: Array.isArray(data.events) ? data.events.length : 0,
            note_count: Array.isArray(data.notes) ? data.notes.length : 0,
            knowledge_count: Array.isArray(data.knowledge) ? data.knowledge.length : 0,
            locale: selection.locale, timezone: data.userTimezone,
          },
          output: { system_prompt: payload.systemPrompt, snapshot_context: payload.snapshotContext },
          attributes: { context_source: 'prompt_assembly', phase: 'snapshot_rebuild' },
        })
        return payload
      },
    }, { locale: selection.locale, workspaceBinding: selection.workspaceBinding, accessScopeHash, signal })
  }
  catch (error) {
    const endedAt = ports.now()
    recordAgentObservation(observation, {
      identity: scope, kind: 'context', name: 'Session snapshot', spanId: `${scope.runId}:session-snapshot`,
      at: endedAt, startedAt: snapshotStartedAt, endedAt, durationMs: Math.max(0, endedAt - snapshotStartedAt),
      status: signal?.aborted ? 'cancelled' : 'error',
      input: { phase: 'prepare', context_epoch: original.contextEpoch, snapshot_hash: original.snapshotHash ?? '', session_info_hash: original.sessionInfoHash ?? '' },
      output: { phase: 'failed' }, attributes: { context_source: 'snapshot_event', snapshot_event: true, failure_reason: signal?.aborted ? 'aborted' : 'snapshot_prepare_failed' },
    })
    throw error
  }
  const snapshotEndedAt = ports.now()
  recordAgentObservation(observation, {
    identity: scope, kind: 'context', name: 'Session snapshot', spanId: `${scope.runId}:session-snapshot`,
    at: snapshotEndedAt, startedAt: snapshotStartedAt, endedAt: snapshotEndedAt,
    durationMs: Math.max(0, snapshotEndedAt - snapshotStartedAt), status: 'success',
    input: { phase: snapshot.phase, context_epoch: snapshot.expectedEpoch, snapshot_hash: original.snapshotHash ?? '', session_info_hash: original.sessionInfoHash ?? '', expires_at: snapshot.state.snapshotExpiresAt ?? null },
    output: { phase: snapshot.phase, context_epoch: snapshot.state.contextEpoch },
    attributes: { context_source: 'snapshot_event', snapshot_event: true },
  })
  const baseline = snapshotHistoryBaseline(snapshot.state)
  const historyStartedAt = ports.now()
  let history: Awaited<ReturnType<typeof loadSessionHistory>>
  try {
    history = await loadSessionHistory(scope, {
      read: async (_, requestSignal) => {
        const read = await ports.historyReader.read(copy(scope), requestSignal)
        return { ...read, baselineSeq: Math.max(read.baselineSeq, baseline) }
      },
      ...(ports.historyReader.hydrateReferences ? { hydrateReferences: (_, rows, requestSignal) => ports.historyReader.hydrateReferences!(copy(scope), rows, requestSignal) } : {}),
      ...(ports.historyReader.images ? { images: ports.historyReader.images } : {}),
    }, signal, { loadImages: selection.allowHistoricalImages })
  }
  catch (error) {
    const historyEndedAt = ports.now()
    recordAgentObservation(observation, {
      identity: scope, kind: 'history', name: 'Initial conversation history', spanId: `${scope.runId}:initial-history`,
      at: historyEndedAt, startedAt: historyStartedAt, endedAt: historyEndedAt,
      durationMs: Math.max(0, historyEndedAt - historyStartedAt), status: signal?.aborted ? 'cancelled' : 'error',
      input: { baseline_message_seq: baseline, allow_historical_images: selection.allowHistoricalImages }, output: {},
      attributes: { context_source: 'initial_history', failure_reason: signal?.aborted ? 'aborted' : 'history_load_failed' },
    })
    throw error
  }
  const historyEndedAt = ports.now()
  recordAgentObservation(observation, {
    identity: scope, kind: 'history', name: 'Initial conversation history', spanId: `${scope.runId}:initial-history`,
    at: historyEndedAt, startedAt: historyStartedAt, endedAt: historyEndedAt,
    durationMs: Math.max(0, historyEndedAt - historyStartedAt), status: 'success',
    input: { baseline_message_seq: baseline, allow_historical_images: selection.allowHistoricalImages },
    output: history.rows,
    attributes: { context_source: 'initial_history', row_count: history.rows.length, baseline_message_seq: baseline },
  })
  const current = await readCurrentTurn(signal)
  signal?.throwIfAborted()
  const request = ports.builder.buildRequest(copy(snapshot.payload), copy(selection), copy(scope))
  const requestBuiltAt = ports.now()
  recordAgentObservation(observation, {
    identity: scope, kind: 'context', name: 'System prompt and snapshot prefix',
    spanId: `${scope.runId}:context:request-prompt`, at: requestBuiltAt,
    startedAt: requestBuiltAt, endedAt: requestBuiltAt, durationMs: 0, status: 'success',
    input: { snapshot_phase: snapshot.phase, system_in_messages: request.systemInMessages },
    output: { system_prompt: request.systemPrompt, fixed_prefix: request.fixedPrefix },
    attributes: { context_source: 'prompt_assembly', phase: 'provider_request' },
  })
  return {
    modelIdentity: selection.modelIdentity, contextWindow: selection.contextWindow,
    input: {
      ...copy(current), ownerId: scope.ownerId, sessionId: scope.sessionId, history: history.rows,
      ...(history.baselineIdentity ? { historyBaseline: copy(history.baselineIdentity) } : {}),
      fixedPrefix: copy(request.fixedPrefix), systemPrompt: request.systemPrompt, systemInMessages: request.systemInMessages,
      latestToolSchemas: copy(request.latestToolSchemas),
      groupChat: selection.groupChat, userTimezone: snapshot.payload.userTimezone, snapshotText: snapshot.payload.snapshotContext,
      allowHistoricalImages: selection.allowHistoricalImages
    },
    sourceEffects: { sessionSnapshot: { expectedEpoch: snapshot.expectedEpoch, expectedSnapshotHash: original.snapshotHash, state: snapshot.state, phase: snapshot.phase } }
  }
}

export const SNAPSHOT_CONTEXT_VERSION = 3

export const DEFAULT_IDLE_TTL_MS = 30 * 60000

export const bindingFields = ['workspace_id', 'workspace_name', 'kind', 'space', 'project_id', 'folder_id', 'project_name', 'folder_name', 'directory_id', 'directory_name'] as const

export function workspaceBindingKey(value: Record<string, Json> | null | undefined): Record<string, Json> {
  return Object.fromEntries(bindingFields.map(key => [key, value?.[key] ?? null]))
}

export function validateSessionSnapshotState(state: SessionSnapshotState): void {
  if (!Number.isSafeInteger(state.contextEpoch) || state.contextEpoch < 0)
    throw new Error('会话快照epoch必须是非负安全整数')
  if (!Number.isSafeInteger(state.baselineMessageSeq) || state.baselineMessageSeq < 0)
    throw new Error('会话快照baseline必须是非负安全整数')
  if (state.context != null && (typeof state.context !== 'object' || Array.isArray(state.context)))
    throw new Error('会话快照context形状无效')
  if (state.snapshotExpiresAt != null && (!Number.isFinite(state.snapshotExpiresAt) || Math.abs(state.snapshotExpiresAt) > Number.MAX_SAFE_INTEGER))
    throw new Error('会话快照过期时间无效')
}

export function snapshotMessageHash(messages: readonly CanonicalMessage[], services: ContextServices): string {
  return services.digest(messages.map(message => ({ role: message.role, content: message.content })))
}

export function sessionSnapshotHash(systemHash: string, sessionHash: string, coveredMessageHash: string, snapshotContextHash: string, services: ContextServices): string {
  return services.digest({
    system_hash: systemHash, session_info_hash: sessionHash,
    covered_message_hash: coveredMessageHash, snapshot_context_hash: snapshotContextHash
  })
}

export function snapshotIsUsable(state: SessionSnapshotState, options: {
  now: number
  locale?: string
  workspaceBinding?: Record<string, Json> | null
  accessScopeHash?: string
}): boolean {
  validateSessionSnapshotState(state)
  const context = state.context
  return context != null && context.system_prompt != null && context.session_info != null
    && context.snapshot_context_version === SNAPSHOT_CONTEXT_VERSION
    && !(state.snapshotExpiresAt != null && state.snapshotExpiresAt <= options.now)
    && (options.locale == null || (context.locale ?? 'zh-CN') === options.locale)
    && (options.accessScopeHash == null || context.access_scope_hash === options.accessScopeHash)
    && (!('workspaceBinding' in options) || stableJson(context.workspace_binding) === stableJson(workspaceBindingKey(options.workspaceBinding)))
}

export function snapshotHistoryBaseline(state: SessionSnapshotState): number {
  const stored = state.context?.history_baseline_message_seq
  if (!Number.isSafeInteger(state.baselineMessageSeq) || state.baselineMessageSeq < 0
    || stored != null && (typeof stored !== 'number' || !Number.isSafeInteger(stored) || stored < 0))
    throw new Error('快照历史水位无效')
  return Math.max(state.baselineMessageSeq, typeof stored === 'number' ? stored : 0)
}

export function readSessionSnapshot(state: SessionSnapshotState): {
  systemPrompt: string
  snapshotContext: string
  sessionInfo: Json
  userTimezone: string
  imChannels: Json
  imMemory: Json
  memorySummaryHash: string
  ragRevision: string
  snapshotHash: string
  historyBaselineMessageSeq: number
  workspaceBinding: Record<string, Json>
} {
  const context = state.context ?? {}
  const binding = context.workspace_binding
  return {
    systemPrompt: String(context.system_prompt || ''), snapshotContext: String(context.snapshot_context || context.dynamic_context || ''),
    sessionInfo: copy(context.session_info || {}), userTimezone: String(context.user_tz || 'LOCAL'),
    imChannels: copy(context.im_channels || {}), imMemory: copy(context.im_memory || {}), memorySummaryHash: String(context.memory_summary_hash || ''),
    ragRevision: String(context.rag_revision ?? context.context_revision ?? 0), snapshotHash: state.snapshotHash ?? '',
    historyBaselineMessageSeq: snapshotHistoryBaseline(state),
    workspaceBinding: workspaceBindingKey(binding && typeof binding === 'object' && !Array.isArray(binding) ? binding : null)
  }
}

/** 只返回事务候选，不自行提交。Data Adapter须将它与本轮消息在同一UoW按epoch CAS写入。 */
export async function ensureSessionSnapshot(identity: HistoryIdentity, original: SessionSnapshotState, ports: SessionSnapshotPorts, options: {
  ttlMs?: number
  locale?: string
  workspaceBinding?: Record<string, Json> | null
  accessScopeHash?: string
  signal?: AbortSignal
} = {}): Promise<{
  state: SessionSnapshotState
  expectedEpoch: number
  phase: 'hit' | 'rebuild'
  payload: ReturnType<typeof readSessionSnapshot>
}> {
  if (identity.ownerId !== original.ownerId || identity.sessionId !== original.sessionId)
    throw new Error('会话快照归属不匹配')
  validateSessionSnapshotState(original)
  const ttl = options.ttlMs ?? DEFAULT_IDLE_TTL_MS, now = ports.now()
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || !Number.isFinite(now))
    throw new Error('快照时钟或TTL无效')
  options.signal?.throwIfAborted()
  const state = copy(original), expectedEpoch = state.contextEpoch
  if (snapshotIsUsable(state, { ...options, now })) {
    state.snapshotExpiresAt = now + ttl
    return { state, expectedEpoch, phase: 'hit', payload: readSessionSnapshot(state) }
  }
  // 业务revision是待吸收元数据，不能作为命中失效条件；只在重建时读取。
  const revision = await ports.currentRevision(identity, options.signal)
  options.signal?.throwIfAborted()
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new Error('上下文版本无效')
  const payload = await ports.loadContext(identity, options.signal)
  options.signal?.throwIfAborted()
  const preserved: Record<string, Json> = {}
  for (const key of ['goal_text', 'goal_status', 'goal_mode', 'stance_digest', 'user_skill_snapshot', 'provider_cache_anchor'])
    if (state.context && key in state.context
      && (key !== 'user_skill_snapshot' || options.accessScopeHash == null || state.context.access_scope_hash === options.accessScopeHash))
      preserved[key] = copy(state.context[key]!)
  const infoHash = ports.digest({ system_prompt: payload.systemPrompt, session_info: payload.sessionInfo })
  state.contextEpoch = state.context == null ? 1 : (state.contextEpoch || 1) + 1
  if (!Number.isSafeInteger(state.contextEpoch))
    throw new Error('会话快照epoch超出安全整数范围')
  state.context = {
    system_prompt: payload.systemPrompt, snapshot_context: payload.snapshotContext, session_info: copy(payload.sessionInfo),
    user_tz: payload.userTimezone || 'LOCAL', im_channels: copy(payload.imChannels ?? {}), im_memory: copy(payload.imMemory ?? {}),
    context_revision: revision, rag_revision: String(revision), memory_summary_hash: payload.memorySummaryHash ?? '',
    locale: payload.locale ?? options.locale ?? 'zh-CN', snapshot_context_hash: ports.digest(payload.snapshotContext),
    snapshot_context_version: SNAPSHOT_CONTEXT_VERSION, history_baseline_message_seq: snapshotHistoryBaseline(original),
    ...(options.accessScopeHash != null ? { access_scope_hash: options.accessScopeHash } : {}),
    workspace_binding: workspaceBindingKey(options.workspaceBinding), ...preserved
  }
  state.sessionInfoHash = infoHash
  state.snapshotHash = sessionSnapshotHash(ports.digest(payload.systemPrompt), infoHash, snapshotMessageHash(payload.coveredMessages ?? [], ports), ports.digest(payload.snapshotContext), ports)
  state.snapshotExpiresAt = now + ttl
  return { state, expectedEpoch, phase: 'rebuild', payload: readSessionSnapshot(state) }
}

export function invalidateSessionSnapshot(original: SessionSnapshotState, now: number): SessionSnapshotState {
  validateSessionSnapshotState(original)
  if (!Number.isSafeInteger(original.contextEpoch + 1) || !Number.isFinite(now))
    throw new Error('会话快照epoch或时钟无效')
  return { ...copy(original), contextEpoch: original.contextEpoch + 1, snapshotExpiresAt: now }
}

export function updateBaselineSnapshot(original: SessionSnapshotState, messages: readonly CanonicalMessage[], ports: ContextServices & {
  now(): number
}, options: {
  baselineMessageSeq?: number
  ttlMs?: number
} = {}): SessionSnapshotState {
  validateSessionSnapshotState(original)
  const state = copy(original), context = readSessionSnapshot(state)
  const baseline = options.baselineMessageSeq ?? state.baselineMessageSeq
  if (!Number.isSafeInteger(baseline) || baseline < 0)
    throw new Error('快照历史水位无效')
  if (baseline < snapshotHistoryBaseline(original))
    throw new Error('快照历史水位不得回退')
  const covered = ports.digest({ previous_snapshot: state.snapshotHash ?? '', new_messages: snapshotMessageHash(messages, ports) })
  state.snapshotHash = sessionSnapshotHash(ports.digest(context.systemPrompt), state.sessionInfoHash ?? ports.digest({ session_info: context.sessionInfo }), covered, '', ports)
  const revision = Number(state.context?.context_revision ?? 0) + 1
  if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(state.contextEpoch + 1))
    throw new Error('会话快照revision或epoch超出安全整数范围')
  state.context = { ...(state.context ?? {}), history_baseline_message_seq: baseline, context_revision: revision, rag_revision: String(revision) }
  state.contextEpoch++
  state.snapshotExpiresAt = ports.now() + (options.ttlMs ?? DEFAULT_IDLE_TTL_MS)
  return state
}

/** 独立的发现与召回共享取消生命周期，不把正文或 watermark 放进全局状态。 */
export async function discoverToolsAndRecall<Tools, Rag>(ports: {
  discover: (signal: AbortSignal) => Promise<Tools>
  recall: (signal: AbortSignal) => Promise<Rag>
  observation?: AgentObservationPort
  identity?: RunIdentity
  now?: () => number
}, signal?: AbortSignal): Promise<{
  tools: Tools
  rag: Rag
}> {
  const controller = new AbortController()
  const cancelled = () => controller.abort()
  if (signal?.aborted)
    throw new AgentRunError('cancelled', '准备已取消')
  signal?.addEventListener('abort', cancelled, { once: true })
  // 两个端口都必须响应 signal，并在返回或抛出前释放自己的短事务/连接。
  const now = ports.now ?? Date.now
  const wasCancelled = () => signal?.aborted === true || controller.signal.aborted
  const measured = async <T>(name: string, spanId: string, operation: () => Promise<T>, summarize: (value: T) => Json): Promise<T> => {
    const startedAt = now()
    try {
      const value = await operation()
      const endedAt = now()
      const summary = summarize(value)
      const ragReason = name === 'Automatic RAG retrieval' && summary && typeof summary === 'object' && !Array.isArray(summary)
        ? (summary as Record<string, Json>).reason : undefined
      const status = typeof ragReason === 'string' && ['timeout', 'capacity_exceeded', 'internal_error', 'unavailable'].includes(ragReason)
        ? 'error' : 'success'
      if (ports.observation && ports.identity)
        recordAgentObservation(ports.observation, {
          identity: ports.identity, kind: 'context', name, spanId, at: endedAt, startedAt, endedAt,
          durationMs: Math.max(0, endedAt - startedAt), status, output: summary,
          attributes: { context_source: name === 'Automatic RAG retrieval' ? 'rag_retrieval' : 'tool_discovery',
            ...(status === 'error' && typeof ragReason === 'string' ? { failure_reason: ragReason } : {}) },
        })
      return value
    }
    catch (error) {
      const endedAt = now()
      if (ports.observation && ports.identity)
        recordAgentObservation(ports.observation, {
          identity: ports.identity, kind: 'context', name, spanId, at: endedAt, startedAt, endedAt,
          durationMs: Math.max(0, endedAt - startedAt), status: wasCancelled() ? 'cancelled' : 'error',
          output: {}, attributes: { context_source: name === 'Automatic RAG retrieval' ? 'rag_retrieval' : 'tool_discovery', failure_reason: wasCancelled() ? 'aborted' : 'preparation_failed' },
        })
      throw error
    }
  }
  const tools = Promise.resolve().then(() => measured('Tool discovery', `${ports.identity?.runId}:tool-discovery`, () => ports.discover(controller.signal), value => ({
    tool_count: Array.isArray(value) ? value.length : 0,
  })))
  const rag = Promise.resolve().then(() => measured('Automatic RAG retrieval', `${ports.identity?.runId}:rag-retrieval`, () => ports.recall(controller.signal), value => {
    const context = value && typeof value === 'object' && !Array.isArray(value) ? value as {
      tail?: unknown
      injected?: unknown
      reason?: unknown
      scope_hits?: unknown
      diagnostics?: unknown
    } : {}
    const diagnostics = context.diagnostics && typeof context.diagnostics === 'object' && !Array.isArray(context.diagnostics)
      ? context.diagnostics as Record<string, unknown> : undefined
    const diagnosticFields = ['engine', 'index_version', 'scope_type', 'vector_doc_count', 'candidate_count', 'accepted_count', 'eligible_count',
      'filtered_count', 'rejected_duplicate', 'rejected_parent', 'rejected_source', 'rejected_similarity',
      'rejected_low_score', 'rejected_not_preferred', 'output_chars', 'elapsed_ms', 'top_confidence',
      'threshold', 'preferred_threshold', 'selection_mode', 'scoring_version', 'rescore_version', 'idf_source',
      'contribution_exponent', 'fallback_reason']
    const scalarDiagnostics: Record<string, Json> = {}
    for (const key of diagnosticFields) {
      const item = diagnostics?.[key]
      if (item === null || ['string', 'boolean', 'number'].includes(typeof item))
        scalarDiagnostics[key] = item as Json
    }
    if (diagnostics?.stage_ms && typeof diagnostics.stage_ms === 'object' && !Array.isArray(diagnostics.stage_ms)) {
      const stages = Object.fromEntries(Object.entries(diagnostics.stage_ms as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'number' && Number.isFinite(value)))
      if (Object.keys(stages).length) scalarDiagnostics.stage_ms = stages as Json
    }
    if (diagnostics?.source_diagnostics && typeof diagnostics.source_diagnostics === 'object' && !Array.isArray(diagnostics.source_diagnostics)) {
      const sources = Object.fromEntries(Object.entries(diagnostics.source_diagnostics as Record<string, unknown>).flatMap(([name, value]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return []
        const counts = Object.fromEntries(Object.entries(value as Record<string, unknown>)
          .filter(([, count]) => typeof count === 'number' && Number.isFinite(count)))
        return Object.keys(counts).length ? [[name, counts]] : []
      }))
      if (Object.keys(sources).length) scalarDiagnostics.source_diagnostics = sources as Json
    }
    if (Array.isArray(diagnostics?.rank_details)) {
      scalarDiagnostics.rank_details = diagnostics.rank_details.flatMap(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const row = item as Record<string, unknown>, summary: Record<string, Json> = {}
        for (const key of ['rank', 'source_quality', 'query_match', 'fused_score', 'normalized_score', 'semantic_norm', 'confidence', 'rank_score', 'query_idf_baseline'])
          if (typeof row[key] === 'number' && Number.isFinite(row[key])) summary[key] = row[key] as number
        if (typeof row.source_type === 'string') summary.source_type = row.source_type
        if (Array.isArray(row.contributions)) {
          summary.contributions = row.contributions.flatMap(contribution => {
            if (!contribution || typeof contribution !== 'object' || Array.isArray(contribution)) return []
            const source = contribution as Record<string, unknown>, value: Record<string, Json> = {}
            if (typeof source.term === 'string') value.term = source.term
            for (const key of ['idf', 'query_weight', 'term_frequency', 'weighted', 'nonlinear'])
              if (typeof source[key] === 'number' && Number.isFinite(source[key])) value[key] = source[key] as number
            return [value]
          })
        }
        return [summary]
      })
    }
    const scopeHits = Array.isArray(context.scope_hits) ? context.scope_hits.flatMap(hit => {
      if (!hit || typeof hit !== 'object' || Array.isArray(hit)) return []
      const row = hit as Record<string, unknown>
      const summary: Record<string, Json> = {}
      if (typeof row.scope === 'string') summary.scope = row.scope
      for (const key of ['candidate_count', 'hit_count'])
        if (typeof row[key] === 'number' && Number.isFinite(row[key])) summary[key] = row[key] as number
      return [summary]
    }) : undefined
    return {
      message_count: Array.isArray(context.tail) ? context.tail.length : 0,
      // LoopScope 需要能还原实际交给 Agent 的 RAG 内容；普通日志不经过这里。
      ...(Array.isArray(context.tail) ? { rag_messages: context.tail as Json[] } : {}),
      ...(typeof context.injected === 'boolean' ? { injected: context.injected } : {}),
      ...(typeof context.reason === 'string' ? { reason: context.reason } : {}),
      ...(scopeHits ? { scope_hits: scopeHits } : {}),
      ...(Object.keys(scalarDiagnostics).length ? { diagnostics: scalarDiagnostics } : {}),
    }
  }))
  try {
    const [found, recalled] = await Promise.all([tools, rag])
    if (controller.signal.aborted)
      throw new AgentRunError('cancelled', '准备已取消')
    return { tools: found, rag: recalled }
  }
  catch (error) {
    controller.abort()
    await Promise.allSettled([tools, rag])
    // 保留端口的原始失败给调用方分类；可见错误只经 Harness presentError 输出。
    throw error
  }
  finally {
    signal?.removeEventListener('abort', cancelled)
  }
}

export const imSources = new Set(['feishu', 'qq', 'wechat', 'telegram'])

export const separator = '\n\n---\n\n'

/** Web/IM/定时入口共用编排；注册过滤不代替 Executor 逐调用复验。 */
export async function prepareRunCapabilities(input: {
  readonly identity: PreparationIdentity
  readonly source: string
  readonly toolNames: readonly string[]
  readonly system: string
  readonly snapshot: string
  readonly tools?: readonly PreparedToolDefinition[]
  readonly query?: string
  readonly userSkillSnapshot?: readonly Json[]
}, ports: CapabilityPreparationPorts, signal?: AbortSignal): Promise<{
  toolNames: readonly string[]
  system: string
  snapshot: string
  catalog: CapabilityCatalog | null
  shellReminder: string
}> {
  signal?.throwIfAborted()
  const identity: PreparationIdentity = Object.freeze({
    ownerId: input.identity.ownerId, workspaceId: input.identity.workspaceId,
    subject: Object.freeze({ ...input.identity.subject }),
  })
  if (!identity.ownerId || !identity.subject.id)
    throw new AgentRunError('invalid_state', '准备缺少可信授权主体')
  let names = input.toolNames.filter((name) => !(imSources.has(input.source) && name === 'present_file') &&
    !(name === 'workspaces' && !ports.workspaceSupported))
  if (names.includes('shell')) {
    const policy = await ports.shellPolicy(identity, signal)
    signal?.throwIfAborted()
    if (!policy.allowed || policy.needsConfirmation)
      names = names.filter((name) => name !== 'shell')
  }
  const configured = await ports.filterConfigured(Object.freeze([...names]), identity, signal)
  signal?.throwIfAborted()
  if (configured.some((name) => !names.includes(name)))
    throw new AgentRunError('invalid_state', '配置过滤不得扩大工具集合')
  names = [...configured]
  let system = input.system
  let shellState: string | null = null
  if (names.includes('shell')) {
    const state = await ports.shellState(identity, signal)
    signal?.throwIfAborted()
    if (state == null)
      names = names.filter((name) => name !== 'shell')
    else shellState = state
  }
  const selectedTools = input.tools?.filter(tool => names.includes(tool.name)).map(copy)
  const catalog = await ports.catalog(Object.freeze([...names]), identity, selectedTools, signal, {
    query: input.query ?? '', ...(input.userSkillSnapshot !== undefined ? { userSkillSnapshot: copy([...input.userSkillSnapshot]) } : {}),
  })
  signal?.throwIfAborted()
  const fileGuidance = shellState === null ? '' : [
    '文件操作优先用已授权的 shell，使用沙箱路径。先用 pwd 或 ls 确认可见目录。',
    '个人文件在 /personal，默认工作区在 /workspace/default，其他工作区在 /workspace/<工作区目录名>，项目文件在 /project 下。使用已知挂载路径，目录名和项目路径以实际返回为准。',
    '浏览目录、查找文件、读取文本和普通文件操作用 shell。当前挂载、只读范围和写入确认规则照常生效；遇到权限限制先走正常授权流程。',
    ...(names.includes('get_project') ? ['查询项目后优先用 get_project 返回的 sandbox_path 定位项目目录。'] : []),
    ...(names.includes('view_image') ? ['找到图片后用 view_image 的 path 查看图片内容。'] : []),
    ...(names.includes('delete_file') ? ['删除文件时优先用 delete_file 移入回收站。'] : []),
  ].join('\n')
  const shellReminder = shellState === null ? '' : catalog?.fixedAdapter
    ? [ports.appendShellProtocol('').trim(), shellState, fileGuidance].filter(Boolean).join(separator)
    : ''
  if (shellState !== null && !catalog?.fixedAdapter)
    system = [ports.appendShellProtocol(system), shellState, fileGuidance].filter(Boolean).join(separator)
  let snapshot = input.snapshot
  if (catalog) {
    if (!Array.isArray(catalog.userSkills)) throw new AgentRunError('invalid_state', '能力目录必须提供明确的用户技能快照')
    // 元数据来自独立Tools；冻结与跨Run一致性由Harness保护，不交回Host自行补编排。
    portableSnapshot(catalog.userSkills)
    if (input.userSkillSnapshot !== undefined && stableJson(catalog.userSkills) !== stableJson(input.userSkillSnapshot))
      throw new AgentRunError('invalid_state', '能力目录改变了已冻结的用户技能快照')
    if (!catalog.metadataOnly && !catalog.fixedAdapter)
      system = [system, catalog.toolCatalog].join(separator)
    snapshot = [snapshot, catalog.skillCatalog].join(separator)
  }
  return { toolNames: Object.freeze(names), system, snapshot, catalog, shellReminder }
}

export function assertRunCapabilities(value: RunCapabilities): void {
  if (!value || !Array.isArray(value.toolNames) || !Array.isArray(value.tools)
    || value.toolNames.some(name => typeof name !== 'string' || !name)
    || new Set(value.toolNames).size !== value.toolNames.length
    || value.tools.length !== value.toolNames.length
    || value.tools.some(tool => !tool || typeof tool.name !== 'string' || !value.toolNames.includes(tool.name)
      || !tool.schema || typeof tool.schema !== 'object' || Array.isArray(tool.schema))
    || new Set(value.tools.map(tool => tool.name)).size !== value.tools.length
    || (value.providerToolNames !== undefined && (!Array.isArray(value.providerToolNames)
      || new Set(value.providerToolNames).size !== value.providerToolNames.length
      || value.providerToolNames.some(name => !value.toolNames.includes(name)))))
    throw new AgentRunError('invalid_state', '本轮能力缺少一致的名称和稳定Schema')
}

/** 自定义完整准备入口也必须返回能力快照，不能绕过标准入口的工具边界。 */
export function requirePreparedCapabilities(load: CanonicalContextPorts['load']): CanonicalContextPorts['load'] {
  return async (identity, signal) => {
    const loaded = await load(identity, signal)
    if (!isEarlyExit(loaded) && !loaded.capabilities)
      throw new AgentRunError('invalid_state', '自定义准备入口必须提供完整能力快照')
    return loaded
  }
}

/** 推荐准备主链：来源 → 并发发现/一次RAG → 能力过滤与目录 → 固定前缀 → Canonical。
 * load只负责owned来源与早退；外部adapter不得再次实现这套顺序。
 */
export function createCanonicalRunLoader(load: CanonicalContextPorts['load'], ports: CanonicalRunPreparationPorts, rag: PreparationPorts, observation?: AgentObservationPort): CanonicalContextPorts['load'] {
  return async (identity, signal) => {
    const preparationStartedAt = Date.now()
    const prepare = async () => {
    const received = await load(copy(identity), signal)
    if (isEarlyExit(received)) {
      const preparationEndedAt = Date.now()
      recordAgentObservation(observation, {
        identity, kind: 'context', name: 'Run context preparation', spanId: `${identity.runId}:run-preparation`,
        at: preparationEndedAt, startedAt: preparationStartedAt, endedAt: preparationEndedAt,
        durationMs: Math.max(0, preparationEndedAt - preparationStartedAt), status: received.response.errored ? 'error' : 'success',
        output: { early_exit: true, reason: received.reason },
        attributes: { context_source: 'run_preparation', ...(received.response.errored ? { failure_reason: received.reason } : {}) },
      })
      return received
    }
    const loaded = copy(received)
    if (loaded.input.ownerId !== identity.ownerId || loaded.input.sessionId !== identity.sessionId)
      throw new AgentRunError('not_found', '准备来源不存在')
    const config = copy(await ports.configuration(copy(identity), signal))
    if (config.identity.ownerId !== identity.ownerId || !config.identity.subject.id
      || config.identity.subject.kind === 'session' && config.identity.subject.id !== identity.sessionId)
      throw new AgentRunError('not_found', '准备授权主体不匹配')
    if (config.identity.subject.kind === 'scheduled_task') loaded.input.entryKind = 'scheduled_task'
    else if (loaded.input.entryKind === 'scheduled_task') throw new AgentRunError('invalid_state', '任务准备类型与可信授权主体不匹配')
    if (config.toolNames.some(name => typeof name !== 'string' || !name) || new Set(config.toolNames).size !== config.toolNames.length)
      throw new AgentRunError('invalid_state', '工具候选名称无效')
    const discovered = await discoverToolsAndRecall({
      discover: abort => ports.discover(copy({ identity: config.identity, toolNames: config.toolNames }), abort, config),
      recall: abort => buildRunRagContext(loaded.input, rag, abort),
      observation, identity, now: Date.now,
    }, signal)
    const tools = portableSnapshot(discovered.tools) as unknown as PreparedToolDefinition[]
    if (!Array.isArray(tools) || tools.some(tool => !tool || typeof tool.name !== 'string' || !tool.name
      || !tool.schema || typeof tool.schema !== 'object' || Array.isArray(tool.schema))
      || new Set(tools.map(tool => tool.name)).size !== tools.length)
      throw new AgentRunError('invalid_state', '发现工具缺少唯一名称或稳定Schema')
    const candidates = [...new Set([...config.toolNames, ...tools.map(tool => tool.name)])]
    const snapshotContext = loaded.sourceEffects?.sessionSnapshot.state.context
    const frozenSkills = snapshotContext?.user_skill_snapshot
    if (frozenSkills !== undefined && !Array.isArray(frozenSkills)) throw new AgentRunError('invalid_state', '会话用户技能快照格式无效')
    const capabilityStartedAt = Date.now()
    let prepared: Awaited<ReturnType<typeof prepareRunCapabilities>>
    try {
      prepared = await prepareRunCapabilities({
        identity: config.identity, source: config.source,
        toolNames: candidates, system: loaded.input.systemPrompt ?? '', snapshot: loaded.input.snapshotText ?? '', tools: copy(tools),
        query: currentRunQuery(loaded.input), ...(frozenSkills !== undefined ? { userSkillSnapshot: frozenSkills as Json[] } : {}),
      }, ports.capabilities, signal)
    }
    catch (error) {
      const capabilityEndedAt = Date.now()
      recordAgentObservation(observation, {
        identity, kind: 'context', name: 'Capability preparation', spanId: `${identity.runId}:capability-preparation`,
        at: capabilityEndedAt, startedAt: capabilityStartedAt, endedAt: capabilityEndedAt,
        durationMs: Math.max(0, capabilityEndedAt - capabilityStartedAt), status: signal?.aborted ? 'cancelled' : 'error',
        input: { candidate_tool_count: candidates.length }, output: {},
        attributes: { context_source: 'capability_preparation', failure_reason: signal?.aborted ? 'aborted' : 'preparation_failed' },
      })
      throw error
    }
    const capabilityEndedAt = Date.now()
    recordAgentObservation(observation, {
      identity, kind: 'context', name: 'Capability preparation', spanId: `${identity.runId}:capability-preparation`,
      at: capabilityEndedAt, startedAt: capabilityStartedAt, endedAt: capabilityEndedAt,
      durationMs: Math.max(0, capabilityEndedAt - capabilityStartedAt), status: 'success',
      input: { candidate_tool_count: candidates.length },
      output: { selected_tool_count: prepared.toolNames.length, catalog_loaded: prepared.catalog !== null },
      attributes: { context_source: 'capability_preparation' },
    })
    signal.throwIfAborted()
    const selected = tools.filter(tool => prepared.toolNames.includes(tool.name))
    if (prepared.toolNames.some(name => !selected.some(tool => tool.name === name)))
      throw new AgentRunError('invalid_state', '选中工具缺少稳定Schema')
    const fixedPrefix = copy([...ports.formatPrefix({ original: copy(loaded.input), system: prepared.system, snapshot: prepared.snapshot })])
    const userSkills = prepared.catalog ? copy([...prepared.catalog.userSkills]) : undefined
    if (snapshotContext && frozenSkills === undefined && userSkills !== undefined)
      snapshotContext.user_skill_snapshot = copy(userSkills)
    const brief = projectAgentToolBrief(prepared.catalog, prepared.toolNames, prepared.shellReminder)
    const { providerToolNames, toolReminder } = brief
    const completed = {
      ...loaded, capabilities: { toolNames: [...prepared.toolNames], tools: selected, subject: copy(config.identity),
        ...brief,
        ...(userSkills !== undefined ? { userSkillSnapshot: userSkills } : {}) },
      input: {
        ...loaded.input, preparedRag: copy(discovered.rag), systemPrompt: prepared.system,
        snapshotText: prepared.snapshot, fixedPrefix,
        ...(toolReminder ? { toolReminder } : {}),
        latestToolSchemas: (providerToolNames ? selected.filter(tool => providerToolNames.includes(tool.name)) : selected).map(tool => ({
          type: 'tool-schema', tool_name: tool.name,
          schema_digest: rag.digest(tool.schema), schema: copy(tool.schema)
        })),
      }
    }
    const preparationEndedAt = Date.now()
    recordAgentObservation(observation, {
      identity, kind: 'context', name: 'Run context preparation', spanId: `${identity.runId}:run-preparation`,
      at: preparationEndedAt, startedAt: preparationStartedAt, endedAt: preparationEndedAt,
      durationMs: Math.max(0, preparationEndedAt - preparationStartedAt), status: 'success',
      input: { source: config.source },
      output: { tool_count: selected.length, rag_message_count: discovered.rag.tail.length },
      attributes: { context_source: 'run_preparation' },
    })
    return completed
    }
    try {
      return await prepare()
    }
    catch (error) {
      const preparationEndedAt = Date.now()
      recordAgentObservation(observation, {
        identity, kind: 'context', name: 'Run context preparation', spanId: `${identity.runId}:run-preparation`,
        at: preparationEndedAt, startedAt: preparationStartedAt, endedAt: preparationEndedAt,
        durationMs: Math.max(0, preparationEndedAt - preparationStartedAt), status: signal?.aborted ? 'cancelled' : 'error',
        input: {}, output: {},
        attributes: { context_source: 'run_preparation', failure_reason: signal?.aborted ? 'aborted' : 'preparation_failed' },
      })
      throw error
    }
  }
}
