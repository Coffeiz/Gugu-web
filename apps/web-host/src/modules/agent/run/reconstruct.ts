import { appendWorkspaceAgentInstructions, assembleSubagentCatalog, builtinSubagentCatalog } from '@gugu/core/agent'
import { canonicalAgentToolName } from '@gugu/core/agent'
import { AgentRunReconstructionVersionError as AgentReconstructionVersionError, createAgentCompactionPort, createAgentRunReconstructor, createAgentRunToolPorts, createLazyAgentCompactionPort, restoreAgentRequestPrefix } from '@gugu/core/agent'
import type { AgentObservationPort, AgentProviderAuxiliaryPorts, AgentRunBinding, AgentRuntimeOptions, CanonicalContextPorts, CanonicalRunContext, CanonicalRunPreparationPorts, ContextDataPorts, ContextSourcePorts, CurrentTurnSources, RunIdentity, HistoryIdentity } from '@gugu/core/agent'
import { adapterFor, type ProviderRuntimeOptions } from '@gugu/core/providers'
import { createProviderReasoningPersistence } from './reasoning/active.js'
import type { OwnedCurrentMessage } from '../context/source.js'
import { createPostgresCurrentTurnReader, createWebAgentSourceLoader } from '../context/source.js'
import { createPersistentAgentRuntime, type PersistentAgentRuntimeOptions } from './runtime.js'
import { createPostgresAgentRunStore } from './store.js'
import { acceptsWebAgentDispatchInput, type AgentDispatchLease } from './dispatch.js'
import type { AgentUsageConfig } from './usage.js'
import { persistRunCompaction, type PrepareCompactedReflection, type StageCompactedReflection } from '../chat/compact.js'
import { createCanonicalHistoryWriter } from '../chat/write.js'
import type { AgentToolRegistryOptions, createAgentToolRegistry } from '../tools/registry.js'
import { createMcpAgentToolPorts, type AgentMcpToolPortsOptions } from '../tools/mcp/ports.js'
import { createAgentContextSources, type AgentContextAssemblyOptions } from '../context/assemble.js'
import { createAuthorizedWebAgentProductionRagRunPorts } from '../rag/production.js'
import { createWebAgentMcpRunPreparation } from '../tools/mcp/prepare.js'
import { createWebAgentMcpRunAuthorization } from '../tools/mcp/authorize.js'
import { createAgentMemoryVectorSearchFactory } from '../memory/vectors.js'
import { createWebAgentReflectionFinalizer, type AgentReflectionTurn } from '../memory/reflection/queue.js'
import { formatAgentHistoryMessageTime } from '../context/time.js'

/** 不含密钥、配置版本或底层异常的可公开错误类型。 */
export interface WebAgentBinding extends AgentRunBinding {
  compactionInstruction?: string
  usageConfig: AgentUsageConfig
}

/** 从与 Provider 相同的原子绑定中取非密钥用量配置，禁止按模型身份字符串推断。 */
export function createWebAgentBindingHistory(lease: AgentDispatchLease, binding: WebAgentBinding,
  commitContinuation?: NonNullable<Parameters<typeof createCanonicalHistoryWriter>[1]>['commitContinuation']): PersistentAgentRuntimeOptions['history'] {
  const identity = Object.freeze({ ...lease.identity })
  const writer = createCanonicalHistoryWriter(async () => binding.usageConfig, { postCommitCompaction: true, commitContinuation })
  return { writeHistory: async (client, candidate, history, checkpoint) => {
    if (candidate.ownerId !== identity.ownerId || candidate.sessionId !== identity.sessionId || candidate.runId !== identity.runId
      || history.context.identity.ownerId !== identity.ownerId || history.context.identity.sessionId !== identity.sessionId
      || history.context.identity.runId !== identity.runId || history.context.modelIdentity !== binding.selection.modelIdentity)
      throw new Error('Agent 用量配置身份不匹配')
    await writer(client, candidate, history, checkpoint)
  } }
}
export interface WebAgentReconstructionResources {
  /** 每个业务数据源均为真实服务；没有服务应返回 null，不得提供假空值。 */
  source: Omit<ContextSourcePorts, 'readSnapshot' | 'historyReader' | 'currentTurn' | 'select' | 'digest' | 'nextId' | 'data'> & { data: Omit<ContextSourcePorts['data'], 'loadImMemory'>; skillDataRoot?: string }
  context: Omit<CanonicalContextPorts, 'load'>
  /** Web Agent 每轮的正式 RAG 构建器；由 Host 按该 lease 提供，Core 准备链直接调用。 */
  ragContext(input: Parameters<CanonicalContextPorts['preparation']['buildRag']>[0], signal?: AbortSignal): ReturnType<CanonicalContextPorts['preparation']['buildRag']>
  preparation: Omit<CanonicalRunPreparationPorts, 'discover'>
  /** 工具 schema 发现和运行时分派必须复用同一个授权注册器。 */
  toolRegistry: Pick<ReturnType<typeof createAgentToolRegistry>, 'capabilities' | 'tools'>
  /** MCP 目录、执行 runtime 与权限由 Host 按同一 lease/owner 装配；缺省时不暴露远端工具。 */
  mcp?: AgentMcpToolPortsOptions
  materialize(identity: RunIdentity, message: OwnedCurrentMessage, signal?: AbortSignal): Promise<CurrentTurnSources>
  runtime: Omit<PersistentAgentRuntimeOptions['runtime'], 'tools'>
  executor: PersistentAgentRuntimeOptions['executor']
  provider: Omit<PersistentAgentRuntimeOptions['provider'], 'resolve'>
  /** Context compaction/reflection ports bind to this Run's exact ProviderRuntime after construction. */
  bindProvider?(provider: AgentProviderAuxiliaryPorts, selected: Awaited<ReturnType<ProviderRuntimeOptions['resolve']>>): void | Promise<void>
  interactionActivation?: PersistentAgentRuntimeOptions['interactionActivation']
}

/** 同一个租约绑定注册器同时提供 Provider schema 和 Harness 实际分派端口。 */
export function createWebAgentToolPorts(
  lease: Pick<AgentDispatchLease, 'identity'>,
  registry: Pick<ReturnType<typeof createAgentToolRegistry>, 'capabilities' | 'tools'>,
  preparation: Omit<CanonicalRunPreparationPorts, 'discover'>,
  mcp?: AgentMcpToolPortsOptions,
): { tools: typeof registry.tools; preparation: CanonicalRunPreparationPorts } {
  const identity = Object.freeze({ ...lease.identity })
  const matchesLease = (candidate: RunIdentity) => candidate.ownerId === identity.ownerId
    && candidate.sessionId === identity.sessionId && candidate.runId === identity.runId
  const boundRegistry = mcp ? createMcpAgentToolPorts({
    base: registry,
    ...mcp,
    async configured(candidate, name, signal) {
      if (!matchesLease(candidate)) return false
      const configuration = await preparation.configuration(candidate, signal ?? new AbortController().signal)
      return configuration.identity.ownerId === identity.ownerId
        && configuration.identity.subject.kind === 'session'
        && configuration.identity.subject.id === identity.sessionId
        && configuration.source === 'web'
        && ((mcp.services && name.startsWith('mcp_') && configuration.toolNames.includes('call_tool') && configuration.toolNames.includes('search_tools'))
          || configuration.toolNames.some(tool => canonicalAgentToolName(tool) === canonicalAgentToolName(name)))
        && (!mcp.configured || await mcp.configured(candidate, name, signal))
    },
  }) : registry
  return createAgentRunToolPorts({
    identity, registry: boundRegistry, preparation, lazyMcp: Boolean(mcp?.services),
    configurationMatches(configuration) {
      return configuration.source === 'web' && configuration.identity.subject.kind === 'session'
        && configuration.identity.subject.id === identity.sessionId
    },
  })
}
export interface WebAgentReconstructorOptions {
  authorizeReasoning?(lease: AgentDispatchLease): Promise<boolean>
  subagentTools?(lease: AgentDispatchLease): Pick<ReturnType<typeof createAgentToolRegistry>, 'tools' | 'capabilities' | 'catalog'>
  readWorkspaceInstructions?(lease: AgentDispatchLease, signal?: AbortSignal): Promise<string | undefined>
  pool: PersistentAgentRuntimeOptions['pool']
  secretKey: string
  redis: PersistentAgentRuntimeOptions['redis']
  subscribe: PersistentAgentRuntimeOptions['subscribe']
  history: PersistentAgentRuntimeOptions['history']
  observation?: AgentRuntimeOptions['observation']
  historyForBinding?(lease: AgentDispatchLease, binding: WebAgentBinding): PersistentAgentRuntimeOptions['history']
  readReconstructionStatus(identity: RunIdentity): Promise<'unavailable' | 'version_conflict' | null>
  /** 已有模型身份只来自已认证解密的 checkpoint；版本发生变化应返回 null。 */
  bind(lease: AgentDispatchLease, checkpoint: CanonicalRunContext | null): Promise<WebAgentBinding | null>
  resources(lease: AgentDispatchLease, binding: WebAgentBinding): Promise<WebAgentReconstructionResources | null>
}

/** 将已配置的 Host 资源与当前租约的上下文、RAG 授权及注册器组合。 */
export function createWebAgentRagResources(options: {
  compactionPool?: PersistentAgentRuntimeOptions['pool']
  observation?: AgentObservationPort
  source: Omit<AgentContextAssemblyOptions, 'digest' | 'nextId' | 'select' | 'currentTurn'>
  rag: Omit<Parameters<typeof createAuthorizedWebAgentProductionRagRunPorts>[0], 'lease' | 'selection'> & {
    /** 每个可信 lease 单独创建写端口；只有实际提供的端口才进入授权配置。 */
    toolPorts?(lease: AgentDispatchLease, binding: WebAgentBinding, context: Pick<ContextDataPorts, 'loadTimezone'>): Promise<Partial<Pick<AgentToolRegistryOptions,
      'conversations' | 'time' | 'knowledge' | 'remember' | 'knowledgeWrites' | 'knowledgeDelete' | 'search' | 'events' | 'calendar' | 'fileOverview' | 'workspaces' | 'workspaceMutations' | 'workspaceCreation' | 'scheduledTasks' | 'scheduledTaskWrites' | 'scheduledTaskDelete' | 'diskTrashTools' | 'canvases' | 'canvasPlaceableSearch' | 'canvasCreation' | 'canvasEdits' | 'canvasPlacements' | 'canvasRelations' | 'noteLifecycle' | 'noteWrites' | 'notes' | 'projects' | 'projectMutations' | 'projectDelete' | 'calendarCreate' | 'calendarUpdate' | 'calendarDelete' | 'canvasBatch' | 'canvasDeleteNote' | 'canvasDisconnect' | 'canvasDelete' | 'clientDelete' | 'skills' | 'skillMetadata' | 'skillManagement' | 'skillDelete' | 'callTool' | 'mcpManagement' | 'httpGet' | 'webSearch' | 'webDownload' | 'similarImageSearch' | 'deepResearch' | 'askUser' | 'shell' | 'viewImage' | 'presentFile' | 'fileDelete' | 'saveAttachment' | 'recentAttachments' | 'sendFile' | 'linkButtons' | 'sendEmail'>>>
  }
  compactionInstruction?: string
  /** Web 私聊反思与 Host Node 消费者共享签名模型范围。 */
  writeSessionTitle?: (lease: AgentDispatchLease, reply: string, complete: (prompt: string) => Promise<string>) => Promise<void>
  reflection?: { enqueue(input: AgentReflectionTurn): Promise<boolean>; enabled?(): boolean; diagnose(): void; stageCompaction?: StageCompactedReflection; prepareCompaction?: PrepareCompactedReflection }
  remaining: Omit<WebAgentReconstructionResources, 'source' | 'ragContext' | 'toolRegistry' | 'preparation'> & {
    preparation: Omit<WebAgentReconstructionResources['preparation'], 'configuration'>
  }
}) {
  const memoryVectorSearch = options.source.memoryVectorSearch ?? (options.rag.embedding
    ? createAgentMemoryVectorSearchFactory({ storageRoot: options.source.memoryStorageRoot, embedding: options.rag.embedding })
    : undefined)
  const source = createAgentContextSources({ ...options.source, ...(memoryVectorSearch ? { memoryVectorSearch } : {}) })
  const reflectionFinalizer = options.reflection ? createWebAgentReflectionFinalizer({
    pool: options.rag.pool,
    enqueue: options.reflection.enqueue,
    diagnose: options.reflection.diagnose,
  }) : null
  return async (lease: AgentDispatchLease, binding: WebAgentBinding): Promise<WebAgentReconstructionResources> => {
    const { toolPorts: createToolPorts, ...ragOptions } = options.rag
    const toolPorts = await createToolPorts?.(lease, binding, { loadTimezone: source.data.loadTimezone }) ?? {}
    const enabledCalendarCanvasTools = [
      ...(toolPorts.calendarCreate ? ['create_event' as const] : []),
      ...(toolPorts.calendarUpdate ? ['update_event' as const] : []),
      ...(toolPorts.calendarDelete ? ['delete_event' as const] : []),
      ...(toolPorts.canvasDelete ? ['canvas_delete' as const] : []),
      ...(toolPorts.canvasDeleteNote ? ['canvas_delete_note' as const] : []),
      ...(toolPorts.canvasDisconnect ? ['canvas_disconnect' as const] : []),
      ...(toolPorts.canvasBatch ? ['canvas_batch' as const] : []),
    ]
    const rag = createAuthorizedWebAgentProductionRagRunPorts({ ...ragOptions, ...toolPorts, observation: options.observation,
      conversationMessageTime: ragOptions.conversationMessageTime ?? (async (identity, timestamp, signal) =>
        formatAgentHistoryMessageTime(timestamp, await source.data.loadTimezone(identity, signal))),
      enabledConversationRead: Boolean(toolPorts.conversations), enabledTime: Boolean(toolPorts.time),
      enabledCalendarRead: Boolean(toolPorts.calendar), enabledUpcoming: Boolean(toolPorts.events && toolPorts.time),
      enabledCalendarCanvasTools,
      enabledWorkspaces: Boolean(toolPorts.workspaces),
      enabledWorkspaceMutations: Boolean(toolPorts.workspaceMutations),
      enabledWorkspaceCreation: Boolean(toolPorts.workspaceCreation),
      enabledTrashList: Boolean(toolPorts.diskTrashTools),
      enabledTrashRestore: Boolean(toolPorts.diskTrashTools),
      enabledTrashPurge: Boolean(toolPorts.diskTrashTools),
      enabledCanvasReads: Boolean(toolPorts.canvases),
      enabledCanvasPlaceableSearch: Boolean(toolPorts.canvasPlaceableSearch),
      enabledCanvasCreate: Boolean(toolPorts.canvasCreation),
      enabledCanvasMutations: Boolean(toolPorts.canvasEdits || toolPorts.canvasPlacements || toolPorts.canvasRelations),
      enabledNoteLifecycle: Boolean(toolPorts.noteLifecycle),
      enabledProjectCreation: Boolean(toolPorts.projects),
      enabledProjectMutations: Boolean(toolPorts.projectMutations),
      enabledNoteReads: Boolean(toolPorts.notes),
      enabledProjectOverview: Boolean(toolPorts.fileOverview),
      enabledScheduledTasks: Boolean(toolPorts.scheduledTasks),
      enabledKnowledgeRead: Boolean(toolPorts.knowledge), enabledKnowledgeWrites: Boolean(toolPorts.knowledgeWrites),
      enabledGlobalSearch: Boolean(toolPorts.search),
      enabledAskUser: Boolean(toolPorts.askUser),
      enabledHttpGet: Boolean(toolPorts.httpGet),
      enabledLinkButtons: Boolean(toolPorts.linkButtons),
      enabledFilePresent: Boolean(toolPorts.presentFile),



      enabledFileDelete: Boolean(toolPorts.diskTrashTools),

      enabledSaveAttachment: Boolean(toolPorts.saveAttachment),
      enabledRecentAttachments: Boolean(toolPorts.recentAttachments),

      enabledSendFile: Boolean(toolPorts.sendFile),

      enabledClientTools: Boolean(ragOptions.core),
      enabledClientDelete: Boolean(toolPorts.clientDelete?.confirmation),
      lease, selection: binding.selection })
    const mcpAuthorization = createWebAgentMcpRunAuthorization(options.rag.pool, lease)
    const mcp = options.remaining.mcp ? {
      ...options.remaining.mcp,
      async authorize(identity: RunIdentity, name: string, signal?: AbortSignal) {
        if (!await mcpAuthorization.authorize(identity, name, signal)) return false
        return options.remaining.mcp!.authorize(identity, name, signal)
      },
    } : undefined
    const configuration = createWebAgentMcpRunPreparation(rag, mcp?.services ? undefined : mcp, options.observation)
    const compactionInstruction = binding.compactionInstruction ?? options.compactionInstruction ?? ''
    let providerBinding: {
      provider: AgentProviderAuxiliaryPorts
      selected: Awaited<ReturnType<ProviderRuntimeOptions['resolve']>>
    } | null = null
    const compactionPort = createLazyAgentCompactionPort(async () => {
      if (!providerBinding) throw new Error('Web Agent Provider 压缩端口尚未绑定')
      const identity = lease.identity
      // 工具授权会验证活动 dispatch lease；等 Harness.start 获取租约后再读取配置。
      const selected = providerBinding.selected
      return createAgentCompactionPort({ provider: providerBinding.provider, identity, modelIdentity: binding.selection.modelIdentity!,
        stableSystem: selected.systemPrompt, scope: selected.accessScopeHash,
        scopeRevision: binding.selection.contextScopeKey ?? null, contextTokens: binding.selection.contextWindow,
        maxOutputTokens: selected.config.max_tokens ?? 0, instruction: compactionInstruction,
        async loadTools(signal) {
          const runConfiguration = await configuration(identity, signal ?? new AbortController().signal)
          const configured = new Set(runConfiguration.toolNames.map(canonicalAgentToolName))
          return (await rag.toolRegistry.capabilities(identity)).filter(definition => configured.has(definition.name)).map(definition => definition.schema)
        },
        digest: context.digest, nextId: context.nextId,
        // 将异常交回 Core compactContext，由它按本次上下文预算调用脱敏诊断并执行旧版确定性回退。
        diagnostic: error => { throw error } })
    })
    const reflectionEnabled = () => (options.reflection?.enabled?.() ?? true)
      && binding.selection.contextPolicy.loadOwnerContext && binding.selection.contextPolicy.memoryEnabled
    const writeSessionTitle = options.writeSessionTitle
    const context: WebAgentReconstructionResources['context'] = {
      ...options.remaining.context,
      ...(writeSessionTitle ? { writeSessionTitle: (input, complete) => writeSessionTitle(lease, input.text, complete) } : {}),
      finalization: { async complete(input) {
        await options.remaining.context.finalization.complete(input)
        await reflectionFinalizer?.(input, reflectionEnabled())
      } },
      compaction: compactionPort,
      async persistCompaction(state) {
        if (options.compactionPool) await persistRunCompaction(options.compactionPool, state, compactionPort, lease.input.userMessageId, undefined,
          reflectionEnabled() ? options.reflection?.stageCompaction : undefined,
          reflectionEnabled() ? options.reflection?.prepareCompaction : undefined)
      },
    }
    return { ...options.remaining, ...(mcp ? { mcp } : {}), context, source, ragContext: rag.ragContext, toolRegistry: rag.toolRegistry,
      preparation: { ...options.remaining.preparation, configuration },
      async bindProvider(provider, selected) {
        providerBinding = { provider, selected }
        await options.remaining.bindProvider?.(provider, selected)
      } }
  }
}

/** Web gateway 的请求来源已由调度载荷验证；历史会话来源不影响本次请求。 */
export function createWebImMemoryLoader(lease: AgentDispatchLease) {
  if (!acceptsWebAgentDispatchInput(lease.input)) throw new AgentReconstructionVersionError('运行来源无法验证')
  const { ownerId, sessionId } = lease.identity
  return async (identity: HistoryIdentity, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    if (identity.ownerId !== ownerId || identity.sessionId !== sessionId) throw new Error('运行身份不匹配')
    return {}
  }
}

/** 为 Core 重建用例装配 Web 的 PostgreSQL、Redis、当前消息与授权资源。 */
export function createWebAgentReconstructor(options: WebAgentReconstructorOptions) {
  const store = createPostgresAgentRunStore<CanonicalRunContext>(options.pool, options.secretKey, options.history)
  return createAgentRunReconstructor<AgentDispatchLease, WebAgentBinding, WebAgentReconstructionResources>({
    acceptsInput: acceptsWebAgentDispatchInput,
    async hasAnchor(identity, userMessageId) {
      const anchor = await options.pool.query(`SELECT 1 FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id
        WHERE s.user_id=$1 AND s.id=$2 AND m.id=$3 AND m.role='user'`, [identity.ownerId, identity.sessionId, userMessageId])
      return anchor.rowCount === 1
    },
    readCheckpoint: store.read,
    bind: options.bind,
    resources: options.resources,
    createRuntime(lease, binding, resources, checkpoint) {
      const id = lease.identity
      const selection = binding.selection
      const source = createWebAgentSourceLoader(options.pool, { ...resources.source, data: { ...resources.source.data, loadImMemory: createWebImMemoryLoader(lease) }, digest: resources.context.digest, nextId: resources.context.nextId,
        select: async () => selection, currentTurn: createPostgresCurrentTurnReader(options.pool, String(lease.input.userMessageId), resources.materialize) }, options.observation, resources.source.skillDataRoot)
      const toolPorts = createWebAgentToolPorts(lease, resources.toolRegistry, resources.preparation, resources.mcp)
      const delegation = options.subagentTools?.(lease)
      const names = new Set(delegation?.catalog().map(tool => tool.name))
      const preparation: CanonicalRunPreparationPorts = delegation ? {
        ...toolPorts.preparation,
        async configuration(identity, signal) {
          const current = await toolPorts.preparation.configuration(identity, signal)
          return { ...current, toolNames: [...new Set([...current.toolNames, ...names])] }
        },
        async discover(input, signal, configuration) {
          return [...await toolPorts.preparation.discover(input, signal, configuration),
            ...(await delegation.capabilities(id)).filter(tool => input.toolNames.includes(tool.name))]
        },
      } : toolPorts.preparation
      const tools = delegation ? {
        ...toolPorts.tools,
        dispatch: (call: Parameters<typeof toolPorts.tools.dispatch>[0], scope: Parameters<typeof toolPorts.tools.dispatch>[1]) =>
          (names.has(call.name) ? delegation.tools : toolPorts.tools).dispatch(call, scope),
        reconcile: (call: Parameters<typeof toolPorts.tools.reconcile>[0], identity: Parameters<typeof toolPorts.tools.reconcile>[1]) =>
          (names.has(call.name) ? delegation.tools : toolPorts.tools).reconcile(call, identity),
      } : toolPorts.tools
      const authorize = options.authorizeReasoning
      let provider: ReturnType<typeof createPersistentAgentRuntime>['provider']
      let reasoning: Promise<ReturnType<typeof createProviderReasoningPersistence>> | undefined
      function reasoningFor(signal = new AbortController().signal) {
        return reasoning ??= Promise.resolve(binding.resolve(id, selection.modelIdentity, signal)).then(selected => {
          const { config, modelIdentity, accessScopeHash } = selected
          const policy = adapterFor(config)
          return createProviderReasoningPersistence({
            pool: options.pool, secretKey: options.secretKey, provider,
            authorize: () => authorize!(lease),
            binding: {
              runId: id.runId, modelIdentity, accessScopeHash, expectedVersion: 0,
              identity: { ownerId: id.ownerId, sessionId: id.sessionId, provider: policy.name,
                apiFormat: policy.protocol(config), model: config.model,
                configDigest: resources.context.digest({ config, accessScopeHash }),
                reasoningConfigDigest: resources.context.digest([config.thinking ?? null, config.reasoning_effort ?? null]) },
            },
          })
        })
      }
      const history = options.historyForBinding?.(lease, binding) ?? createWebAgentBindingHistory(lease, binding,
        authorize ? async (client, _identity, context) => (await reasoningFor()).commitSuccess(client, context) : undefined)
      const instance = createPersistentAgentRuntime({ pool: options.pool, secretKey: options.secretKey, redis: options.redis, subscribe: options.subscribe, history: { ...history,
          ...(authorize ? { async persistPrivateContext(client, identity, next, previous) {
            await history.persistPrivateContext?.(client, identity, next, previous)
            if (next.context?.continuationRef || previous?.context?.continuationRef)
              await (await reasoningFor()).checkpointHook(client, identity, next, previous)
          } } : {}),
        },
        observation: options.observation,
        context: { ...resources.context,
          ...(authorize ? { async initializeContinuation(context, signal, areaDigest) {
            return (await reasoningFor(signal)).initialize(context, signal, areaDigest)
          } } : {}),
          ...(checkpoint ? { prepareRequest: restoreAgentRequestPrefix(id, checkpoint, selection, {
            digest: resources.context.digest,
            builder: resources.source.builder,
          }) } : {}),
          preparation: { ...resources.context.preparation, buildRag: resources.ragContext }, async load(identity, signal) {
            const loaded = await source.load(identity, signal)
            if (delegation && (await delegation.capabilities(identity)).some(tool => tool.name === 'agent_message')) {
              loaded.input.systemPrompt = assembleSubagentCatalog(loaded.input.systemPrompt, builtinSubagentCatalog)
            }
            const instructions = await options.readWorkspaceInstructions?.(lease, signal)
            signal?.throwIfAborted()
            if (instructions) loaded.input.systemPrompt = appendWorkspaceAgentInstructions(loaded.input.systemPrompt ?? '', instructions)
            return loaded
          } }, runPreparation: preparation,
        runtime: { ...resources.runtime, tools }, executor: resources.executor,
        provider: { ...resources.provider, resolve: binding.resolve,
          ...(authorize ? {
            async ensureContinuation(context, signal) { await (await reasoningFor(signal)).ensure(context, signal) },
            async invalidateContinuation(context, signal) { await (await reasoningFor(signal)).invalidate(context, signal) },
          } : {}),
        }, interactionActivation: resources.interactionActivation,
        scheduling: { mode: 'dispatch', readReconstructionStatus: options.readReconstructionStatus, leaseFor: target => target.ownerId === id.ownerId && target.sessionId === id.sessionId && target.runId === id.runId ? lease : null } })
      provider = instance.provider
      return instance
    },
  })
}
