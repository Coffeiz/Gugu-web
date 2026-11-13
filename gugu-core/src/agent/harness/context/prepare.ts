
import type { CanonicalMessage,CanonicalSourceLoaderResult,CapabilityCatalog,ContextData,ContextLoadPolicy,HistoryIdentity,Json,PreparationIdentity,PreparedToolDefinition,RunCapabilities,RunIdentity,SessionSnapshotState } from '../contracts.js'
import { HarnessError,isEarlyExit } from '../contracts.js'
import { copy,portableSnapshot,stableJson } from '../history/canonical-history.js'
import { loadSessionHistory } from '../history/ordering.js'
import type { CanonicalContextPorts,CanonicalRunPreparationPorts,CapabilityPreparationPorts,ContextDataPorts,ContextServices,ContextSourcePorts,PreparationPorts,SessionSnapshotPorts } from '../ports.js'
import { buildRunRagContext,currentRunQuery } from './assemble.js'

/** 权限策略由可信Host计算；受限群成员只能读取自己的scope记忆与时区，不能触碰owner域。 */
export async function loadContextData(identity: HistoryIdentity, policy: ContextLoadPolicy, ports: ContextDataPorts, signal?: AbortSignal): Promise<ContextData> {
  signal?.throwIfAborted()
  const userTimezone = await ports.loadTimezone(identity, signal)
  signal?.throwIfAborted()
  if (!policy.loadOwnerContext) {
    const imMemory = await ports.loadImMemory(identity, signal)
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
  const memory = policy.memoryEnabled ? start(() => ports.loadMemory(identity, cancel.signal)) : Promise.resolve({ ok: true as const, value: {} })
  const imMemory = start(() => ports.loadImMemory(identity, cancel.signal))
  const knowledge = start(() => ports.loadKnowledge(identity, cancel.signal))
  try {
    cancel.signal.throwIfAborted()
    const projects = await ports.loadProjects(identity, cancel.signal)
    cancel.signal.throwIfAborted()
    const events = await ports.loadEvents(identity, userTimezone, cancel.signal)
    cancel.signal.throwIfAborted()
    const notes = await ports.loadNotes(identity, cancel.signal)
    cancel.signal.throwIfAborted()
    const filesOverview = await ports.loadFilesOverview(identity, cancel.signal)
    cancel.signal.throwIfAborted()
    const stylePreferences = await ports.loadStylePreferences(identity, cancel.signal)
    cancel.signal.throwIfAborted()
    const imChannels = await ports.loadImChannels(identity, cancel.signal)
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
export function createCanonicalSourceLoader(ports: ContextSourcePorts): {
  load(identity: RunIdentity, signal: AbortSignal): Promise<CanonicalSourceLoaderResult>
} {
  return { load: (identity, signal) => prepareRunContextSources(identity, ports, signal) }
}

export async function prepareRunContextSources(identity: RunIdentity, ports: ContextSourcePorts, signal?: AbortSignal): Promise<CanonicalSourceLoaderResult> {
  const scope = copy(identity)
  signal?.throwIfAborted()
  const original = await ports.readSnapshot(copy(scope), signal)
  if (!original || original.ownerId !== scope.ownerId || original.sessionId !== scope.sessionId)
    throw new Error('会话上下文不存在')
  validateSessionSnapshotState(original)
  const selection = await ports.select(copy(scope), signal)
  if (!selection.modelIdentity || !Number.isSafeInteger(selection.contextWindow) || selection.contextWindow < 1)
    throw new Error('模型上下文身份或预算无效')
  if (selection.groupChat && (!selection.contextScopeKey || !selection.contextScopeKey.trim()))
    throw new Error('群上下文需要可信actor作用域绑定')
  const accessScopeHash = ports.digest({
    owner_id: scope.ownerId, session_id: scope.sessionId, group_chat: selection.groupChat,
    scope_key: selection.contextScopeKey ?? 'owner', load_owner_context: selection.contextPolicy.loadOwnerContext, memory_enabled: selection.contextPolicy.memoryEnabled
  })
  signal?.throwIfAborted()
  const snapshot = await ensureSessionSnapshot(scope, original, {
    digest: ports.digest, nextId: ports.nextId, now: ports.now,
    currentRevision: (_, requestSignal) => ports.currentRevision(copy(scope), requestSignal),
    loadContext: async (_, requestSignal) => {
      const data = await loadContextData(copy(scope), selection.contextPolicy, ports.data, requestSignal)
      requestSignal?.throwIfAborted()
      return ports.builder.buildSnapshot(copy(data), copy(selection), copy(scope))
    },
  }, { locale: selection.locale, workspaceBinding: selection.workspaceBinding, accessScopeHash, signal })
  const baseline = snapshotHistoryBaseline(snapshot.state)
  const history = await loadSessionHistory(scope, {
    read: async (_, requestSignal) => {
      const read = await ports.historyReader.read(copy(scope), requestSignal)
      return { ...read, baselineSeq: Math.max(read.baselineSeq, baseline) }
    },
    ...(ports.historyReader.hydrateReferences ? { hydrateReferences: (_, rows, requestSignal) => ports.historyReader.hydrateReferences!(copy(scope), rows, requestSignal) } : {}),
    ...(ports.historyReader.images ? { images: ports.historyReader.images } : {}),
  }, signal, { loadImages: selection.allowHistoricalImages })
  const current = await ports.currentTurn(copy(scope), signal)
  signal?.throwIfAborted()
  const request = ports.builder.buildRequest(copy(snapshot.payload), copy(selection), copy(scope))
  return {
    modelIdentity: selection.modelIdentity, contextWindow: selection.contextWindow,
    input: {
      ...copy(current), ownerId: scope.ownerId, sessionId: scope.sessionId, history: history.rows,
      fixedPrefix: copy(request.fixedPrefix), systemPrompt: request.systemPrompt, systemInMessages: request.systemInMessages,
      latestToolSchemas: copy(request.latestToolSchemas),
      groupChat: selection.groupChat, userTimezone: snapshot.payload.userTimezone, snapshotText: snapshot.payload.snapshotContext,
      allowHistoricalImages: selection.allowHistoricalImages
    },
    sourceEffects: { sessionSnapshot: { expectedEpoch: snapshot.expectedEpoch, state: snapshot.state, phase: snapshot.phase } }
  }
}

export const SNAPSHOT_CONTEXT_VERSION = 3

export const DEFAULT_IDLE_TTL_MS = 30 * 60000

export const bindingFields = ['workspace_id', 'workspace_name', 'kind', 'space', 'project_id', 'folder_id', 'project_name', 'folder_name'] as const

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
}, signal?: AbortSignal): Promise<{
  tools: Tools
  rag: Rag
}> {
  const controller = new AbortController()
  const cancelled = () => controller.abort()
  if (signal?.aborted)
    throw new HarnessError('cancelled', '准备已取消')
  signal?.addEventListener('abort', cancelled, { once: true })
  // 两个端口都必须响应 signal，并在返回或抛出前释放自己的短事务/连接。
  const tools = Promise.resolve().then(() => ports.discover(controller.signal))
  const rag = Promise.resolve().then(() => ports.recall(controller.signal))
  try {
    const [found, recalled] = await Promise.all([tools, rag])
    if (controller.signal.aborted)
      throw new HarnessError('cancelled', '准备已取消')
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
}> {
  signal?.throwIfAborted()
  const identity: PreparationIdentity = Object.freeze({
    ownerId: input.identity.ownerId, workspaceId: input.identity.workspaceId,
    subject: Object.freeze({ ...input.identity.subject }),
  })
  if (!identity.ownerId || !identity.subject.id)
    throw new HarnessError('invalid_state', '准备缺少可信授权主体')
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
    throw new HarnessError('invalid_state', '配置过滤不得扩大工具集合')
  names = [...configured]
  let system = input.system
  if (names.includes('shell')) {
    const state = await ports.shellState(identity, signal)
    signal?.throwIfAborted()
    if (state == null)
      names = names.filter((name) => name !== 'shell')
    else
      system = [ports.appendShellProtocol(system), state].join(separator)
  }
  const selectedTools = input.tools?.filter(tool => names.includes(tool.name)).map(copy)
  const catalog = await ports.catalog(Object.freeze([...names]), identity, selectedTools, signal, {
    query: input.query ?? '', ...(input.userSkillSnapshot !== undefined ? { userSkillSnapshot: copy([...input.userSkillSnapshot]) } : {}),
  })
  signal?.throwIfAborted()
  let snapshot = input.snapshot
  if (catalog) {
    if (!Array.isArray(catalog.userSkills)) throw new HarnessError('invalid_state', '能力目录必须提供明确的用户技能快照')
    // 元数据来自独立Tools；冻结与跨Run一致性由Harness保护，不交回Host自行补编排。
    portableSnapshot(catalog.userSkills)
    if (input.userSkillSnapshot !== undefined && stableJson(catalog.userSkills) !== stableJson(input.userSkillSnapshot))
      throw new HarnessError('invalid_state', '能力目录改变了已冻结的用户技能快照')
    if (!catalog.metadataOnly)
      system = [system, catalog.toolCatalog].join(separator)
    snapshot = [snapshot, catalog.skillCatalog].join(separator)
  }
  return { toolNames: Object.freeze(names), system, snapshot, catalog }
}

export function assertRunCapabilities(value: RunCapabilities): void {
  if (!value || !Array.isArray(value.toolNames) || !Array.isArray(value.tools)
    || value.toolNames.some(name => typeof name !== 'string' || !name)
    || new Set(value.toolNames).size !== value.toolNames.length
    || value.tools.length !== value.toolNames.length
    || value.tools.some(tool => !tool || typeof tool.name !== 'string' || !value.toolNames.includes(tool.name)
      || !tool.schema || typeof tool.schema !== 'object' || Array.isArray(tool.schema))
    || new Set(value.tools.map(tool => tool.name)).size !== value.tools.length)
    throw new HarnessError('invalid_state', '本轮能力缺少一致的名称和稳定Schema')
}

/** 自定义完整准备入口也必须返回能力快照，不能绕过标准入口的工具边界。 */
export function requirePreparedCapabilities(load: CanonicalContextPorts['load']): CanonicalContextPorts['load'] {
  return async (identity, signal) => {
    const loaded = await load(identity, signal)
    if (!isEarlyExit(loaded) && !loaded.capabilities)
      throw new HarnessError('invalid_state', '自定义准备入口必须提供完整能力快照')
    return loaded
  }
}

/** 推荐准备主链：来源 → 并发发现/一次RAG → 能力过滤与目录 → 固定前缀 → Canonical。
 * load只负责owned来源与早退；外部adapter不得再次实现这套顺序。
 */
export function createCanonicalRunLoader(load: CanonicalContextPorts['load'], ports: CanonicalRunPreparationPorts, rag: PreparationPorts): CanonicalContextPorts['load'] {
  return async (identity, signal) => {
    const received = await load(copy(identity), signal)
    if (isEarlyExit(received))
      return received
    const loaded = copy(received)
    if (loaded.input.ownerId !== identity.ownerId || loaded.input.sessionId !== identity.sessionId)
      throw new HarnessError('not_found', '准备来源不存在')
    const config = copy(await ports.configuration(copy(identity), signal))
    if (config.identity.ownerId !== identity.ownerId || !config.identity.subject.id
      || config.identity.subject.kind === 'session' && config.identity.subject.id !== identity.sessionId)
      throw new HarnessError('not_found', '准备授权主体不匹配')
    if (config.identity.subject.kind === 'scheduled_task') loaded.input.entryKind = 'scheduled_task'
    else if (loaded.input.entryKind === 'scheduled_task') throw new HarnessError('invalid_state', '任务准备类型与可信授权主体不匹配')
    if (config.toolNames.some(name => typeof name !== 'string' || !name) || new Set(config.toolNames).size !== config.toolNames.length)
      throw new HarnessError('invalid_state', '工具候选名称无效')
    const discovered = await discoverToolsAndRecall({
      discover: abort => ports.discover(copy({ identity: config.identity, toolNames: config.toolNames }), abort),
      recall: abort => buildRunRagContext(loaded.input, rag, abort),
    }, signal)
    const tools = portableSnapshot(discovered.tools) as unknown as PreparedToolDefinition[]
    if (!Array.isArray(tools) || tools.some(tool => !tool || typeof tool.name !== 'string' || !tool.name
      || !tool.schema || typeof tool.schema !== 'object' || Array.isArray(tool.schema))
      || new Set(tools.map(tool => tool.name)).size !== tools.length)
      throw new HarnessError('invalid_state', '发现工具缺少唯一名称或稳定Schema')
    const candidates = [...new Set([...config.toolNames, ...tools.map(tool => tool.name)])]
    const snapshotContext = loaded.sourceEffects?.sessionSnapshot.state.context
    const frozenSkills = snapshotContext?.user_skill_snapshot
    if (frozenSkills !== undefined && !Array.isArray(frozenSkills)) throw new HarnessError('invalid_state', '会话用户技能快照格式无效')
    const prepared = await prepareRunCapabilities({
      identity: config.identity, source: config.source,
      toolNames: candidates, system: loaded.input.systemPrompt ?? '', snapshot: loaded.input.snapshotText ?? '', tools: copy(tools),
      query: currentRunQuery(loaded.input), ...(frozenSkills !== undefined ? { userSkillSnapshot: frozenSkills as Json[] } : {}),
    }, ports.capabilities, signal)
    signal.throwIfAborted()
    const selected = tools.filter(tool => prepared.toolNames.includes(tool.name))
    if (prepared.toolNames.some(name => !selected.some(tool => tool.name === name)))
      throw new HarnessError('invalid_state', '选中工具缺少稳定Schema')
    const fixedPrefix = copy([...ports.formatPrefix({ original: copy(loaded.input), system: prepared.system, snapshot: prepared.snapshot })])
    const userSkills = prepared.catalog ? copy([...prepared.catalog.userSkills]) : undefined
    if (snapshotContext && frozenSkills === undefined && userSkills !== undefined)
      snapshotContext.user_skill_snapshot = copy(userSkills)
    return {
      ...loaded, capabilities: { toolNames: [...prepared.toolNames], tools: selected, subject: copy(config.identity),
        ...(userSkills !== undefined ? { userSkillSnapshot: userSkills } : {}) },
      input: {
        ...loaded.input, preparedRag: copy(discovered.rag), systemPrompt: prepared.system,
        snapshotText: prepared.snapshot, fixedPrefix,
        latestToolSchemas: selected.map(tool => ({
          type: 'tool-schema', tool_name: tool.name,
          schema_digest: rag.digest(tool.schema), schema: copy(tool.schema)
        })),
      }
    }
  }
}
