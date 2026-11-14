
import type { ExecutionRequest,ExecutionResult } from '../executor/contracts.js'
import type { ensureSessionSnapshot } from './context/prepare.js'
import type { ReflectionSnapshots } from './context/reflection.js'
import type { Block,BranchInput,BranchName,CanonicalAreaSnapshot,CanonicalCompletionInput,CanonicalMessage,CanonicalSourceEffects,CapabilityCatalog,CompactionSummaryInput,ContextData,ContextSourceSelection,CurrentTurnSources,DispatchOutcome,DisplayItem,EarlyExit,FrozenProviderRequest,HistoryIdentity,InteractionResolution,Json,Lease,MessageEntry,NormalizedProviderRecovery,OpaqueProviderProjection,PendingInteraction,PersistedHistoryRow,PreparationIdentity,PrepareContextInput,PreparedContext,PreparedToolDefinition,ProviderEvent,ProviderRecoveryBoundary,ProviderRequest,RagContext,ReflectionSnapshot,ReplyFacts,ReplyGateCall,RunCapabilities,RunCheckpoint,RunEvent,RunIdentity,SanitizerCheckpoint,SessionSnapshotState,SnapshotPayload,ToolCall,ToolPlan,ToolResult,Usage } from './contracts.js'

export interface ProviderProjectionPort<Wire> {
  project(input: {
    snapshot: CanonicalAreaSnapshot
    prefix: CanonicalMessage[]
    dynamicTail: CanonicalMessage[]
    modelIdentity: string
  }): OpaqueProviderProjection<Wire>
}

export interface ContextServices {
  /** Host 注入稳定 JSON 的不可逆指纹；不得以原文充当指纹。 */
  digest(value: unknown): string
  nextId(): string
}

/** 查询实现归 Data Adapter；读取必须属于同一个 owner/session 和稳定读取视图。 */
export interface HistoryReaderPort {
  read(input: HistoryIdentity, signal?: AbortSignal): Promise<{
    baselineSeq: number
    rows: PersistedHistoryRow[]
  }>
  /** 只返回已通过 owner 授权的内容块，不能把真实路径或签名 URL 落入 Canonical。 */
  hydrateReferences?(input: HistoryIdentity, rows: readonly PersistedHistoryRow[], signal?: AbortSignal): Promise<PersistedHistoryRow[]>
  readonly images?: HistoryImageReaderPort
}

export interface HistoryImageReaderPort {
  readSizes(identity: HistoryIdentity, candidateIds: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, number>>
  readPayloads(identity: HistoryIdentity, selectedIds: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, readonly Block[]>>
}

export interface ContextReferenceCodec {
  /** 必须用可信owner恢复/验证稳定引用；缺失附件不能以空正文伪装成功。 */
  dehydrate(entry: MessageEntry, identity: HistoryIdentity, signal?: AbortSignal): Promise<CanonicalMessage>
  hydrate(entry: MessageEntry, identity: HistoryIdentity, signal?: AbortSignal): Promise<CanonicalMessage>
}

export interface PreparationPorts extends ContextServices {
  buildRag(input: HistoryIdentity & {
    query: string
    history: readonly PersistedHistoryRow[]
    beforeMessageId: string | null
    snapshotText: string
  }, signal?: AbortSignal): Promise<RagContext>
  formatMessageTime?: (timestamp: string | number, timezone: string) => string
}

export interface CanonicalContextPorts extends ContextServices {
  readonly finalization: CanonicalFinalizationPort
  readonly references: ContextReferenceCodec
  load(identity: RunIdentity, signal: AbortSignal): Promise<{
    input: PrepareContextInput
    modelIdentity: string
    contextWindow: number
    sourceEffects?: CanonicalSourceEffects
    accessScopeHash?: string
    replyContext?: {
      userRequest?: string
      locale?: string
      decisionGuardEnabled?: boolean
    }
    capabilities?: RunCapabilities
  } | EarlyExit>
  readonly preparation: Omit<PreparationPorts, keyof ContextServices>
  prepareRequest(identity: RunIdentity, signal?: AbortSignal): Promise<{
    prefix: CanonicalMessage[]
    dynamicTail: CanonicalMessage[]
  }>
  /** 压缩模型调用由独立 Provider adapter 提供，Harness 负责候选/边界/应用顺序。 */
  readonly compaction: CompactionPort<unknown>
  /** 从进程内快照取精确匹配的已追加主轮输出投影；缺失只能显式重建。 */
  currentRequest(identity: RunIdentity, input: {
    checkpointDigest: string
    modelIdentity: string
    accessScopeHash: string
    materialized: PreparedContext
  }): FrozenProviderRequest | null
  /** 只暂存不透明续接材料并返回非敏感记录ID；最终是否加密持久化按Reasoning策略与history事务共同决定，不能提前写库/发布。 */
  stageContinuation(input: {
    identity: RunIdentity
    round: number
    modelIdentity: string
    accessScopeHash: string
    areaDigest: string
    value: unknown
  }): Promise<string>
  /** 释放本Run未提交的进程内私有材料；已由history事务接收的加密记录不在此删除。 */
  releaseContinuations(identity: RunIdentity): Promise<void>
  /** 受限诊断端口；原始摘要失败不得进入checkpoint、公开事件或日志。 */
  diagnoseCompactionFailure(input: {
    identity: RunIdentity
    revision: number
    contextInput: number
  }, error: unknown): void
}

export interface ContextDataPorts {
  loadTimezone(identity: HistoryIdentity, signal?: AbortSignal): Promise<string>
  loadProjects(identity: HistoryIdentity, signal?: AbortSignal): Promise<Json>
  loadEvents(identity: HistoryIdentity, timezone: string, signal?: AbortSignal): Promise<Json>
  loadNotes(identity: HistoryIdentity, signal?: AbortSignal): Promise<Json>
  loadFilesOverview(identity: HistoryIdentity, signal?: AbortSignal): Promise<Json>
  loadStylePreferences(identity: HistoryIdentity, signal?: AbortSignal): Promise<Json>
  loadImChannels(identity: HistoryIdentity, signal?: AbortSignal): Promise<Json>
  /** 下列端口不得复用上方串行数据库session。 */
  loadMemory(identity: HistoryIdentity, signal?: AbortSignal): Promise<Json>
  loadImMemory(identity: HistoryIdentity, signal?: AbortSignal): Promise<Json>
  loadKnowledge(identity: HistoryIdentity, signal?: AbortSignal): Promise<Json>
}

export interface ContextSourcePorts extends ContextServices {
  now(): number
  /** 与historyReader共享一致读取视图；不存在/不归属不能返回另一用户的空白替代品。 */
  readSnapshot(identity: RunIdentity, signal?: AbortSignal): Promise<SessionSnapshotState | null>
  readonly historyReader: HistoryReaderPort
  readonly data: ContextDataPorts
  currentRevision(identity: RunIdentity, signal?: AbortSignal): Promise<number>
  /** BYOK/Provider选择由独立模块负责；这里只接收不含凭据的稳定模型身份和预算。 */
  select(identity: RunIdentity, signal?: AbortSignal): Promise<ContextSourceSelection>
  /** 附件claim/授权不在来源loader复制；适配器返回所属当前用户的Canonical输入。 */
  currentTurn(identity: RunIdentity, signal?: AbortSignal): Promise<CurrentTurnSources>
  readonly builder: {
    /** 纯格式化边界，各数据域提供自己的可读概览；不得在此另开数据库或扩大读取权限。 */
    buildSnapshot(data: ContextData, selection: ContextSourceSelection, identity: RunIdentity): SnapshotPayload
    /** 每Run重算静态system；冻结snapshot正文仍由上一个步骤维护。 */
    buildRequest(snapshot: Awaited<ReturnType<typeof ensureSessionSnapshot>>['payload'], selection: ContextSourceSelection, identity: RunIdentity): {
      systemPrompt: string
      systemInMessages: boolean
      fixedPrefix: CanonicalMessage[]
      latestToolSchemas?: readonly Block[]
    }
  }
}

export interface SessionSnapshotPorts extends ContextServices {
  now(): number
  currentRevision(identity: HistoryIdentity, signal?: AbortSignal): Promise<number>
  loadContext(identity: HistoryIdentity, signal?: AbortSignal): Promise<SnapshotPayload>
}

export interface CapabilityPreparationPorts {
  readonly workspaceSupported: boolean
  filterConfigured(names: readonly string[], identity: PreparationIdentity, signal?: AbortSignal): Promise<readonly string[]>
  shellPolicy(identity: PreparationIdentity, signal?: AbortSignal): Promise<{
    readonly allowed: boolean
    readonly needsConfirmation: boolean
  }>
  /** 唯一允许注入的实时权限说明：现有系统范围 Shell 环境说明。 */
  shellState(identity: PreparationIdentity, signal?: AbortSignal): Promise<string | null>
  appendShellProtocol(system: string): string
  /** 只返回目录元数据，不允许把工具权限范围写进提示词。 */
  catalog(names: readonly string[], identity: PreparationIdentity, tools?: readonly PreparedToolDefinition[], signal?: AbortSignal, context?: {
    readonly query: string
    readonly userSkillSnapshot?: readonly Json[]
  }): Promise<CapabilityCatalog | null>
}

export interface CanonicalRunPreparationPorts {
  /** 读取本轮可信入口配置，不从用户正文或Provider声明推导权限主体。 */
  configuration(identity: RunIdentity, signal: AbortSignal): Promise<{
    identity: PreparationIdentity
    source: string
    toolNames: readonly string[]
  }>
  /** 真实Tools/MCP adapter负责发现和Schema；Core不注册handler或连接外部服务。 */
  discover(input: {
    identity: PreparationIdentity
    toolNames: readonly string[]
  }, signal: AbortSignal): Promise<readonly PreparedToolDefinition[]>
  readonly capabilities: CapabilityPreparationPorts
  /** 纯格式化：更新快照正文固定位置，不重新查询或执行权限编排。
   * original.systemInMessages为true时，system由Canonical主prepare添加，返回值不重复包含system。
   */
  formatPrefix(input: {
    original: PrepareContextInput
    system: string
    snapshot: string
  }): readonly CanonicalMessage[]
}

export interface CompactionPort<Wire> {
  summarize(input: CompactionSummaryInput<Wire>, signal?: AbortSignal): Promise<string>
  recordEmergencySummary?(metadata: {
    reason: 'empty_provider_summary'
    beforeMessages: number
    summaryFingerprint: string
  }): void
}

export interface SummaryGenerationPorts<Wire> extends BranchPorts<Wire> {
  /** Wire协议字段由Provider adapter操作；Harness只决定何时执行哪种有界裁切。 */
  transformProjection(projection: OpaqueProviderProjection<Wire>, stage: 'strip-tool-inputs' | 'trim-oldest-units'): {
    projection: OpaqueProviderProjection<Wire>
    changedMessages: number
  }
}

export interface ReflectionProjectionPort<Wire> {
  /** 只在同协议 wire 上追加尾部消息并移除 dynamic tail，不能重新渲染原始前缀。 */
  append(projection: OpaqueProviderProjection<Wire>, tail: readonly CanonicalMessage[]): OpaqueProviderProjection<Wire>
}

export interface PassiveGroupTailPorts<Wire> extends ReflectionProjectionPort<Wire> {
  /** Adapter在同一scope内校验owner/platform/bot/chat/group会话绑定，不能只按裸sessionId查询。 */
  ownsGroupSession(identity: HistoryIdentity, signal?: AbortSignal): Promise<boolean>
  readTail(identity: HistoryIdentity, afterMessageId: string | null, throughMessageId: string | null, signal?: AbortSignal): Promise<PersistedHistoryRow[]>
  renderTail(rows: readonly PersistedHistoryRow[], modelIdentity: string, signal?: AbortSignal): Promise<CanonicalMessage[]>
}

export interface ReflectionRecoveryPorts<Wire> {
  /** Adapter在owner/scope内读取，未知/越权必须返回null。 */
  readSession(identity: HistoryIdentity, signal?: AbortSignal): Promise<(HistoryIdentity & {
    executionState: string
    pendingMessageCount: number
    accessScopeHash: string
  }) | null>
  acquire(identity: HistoryIdentity, signal?: AbortSignal): Promise<string | null>
  release(identity: HistoryIdentity, lease: string): Promise<void>
  rebuild(identity: HistoryIdentity, modelIdentity: string, lease: string, accessScopeHash: string, signal?: AbortSignal): Promise<ReflectionSnapshot<Wire> | null>
  /** Data模块同事务维护正式summary/watermark，不由Harness直写数据库。 */
  compactBaseline(identity: HistoryIdentity, snapshot: ReflectionSnapshot<Wire>, lease: string, signal?: AbortSignal): Promise<'not_needed' | 'compacted' | 'blocked'>
}

export interface BranchProviderPort<Wire> {
  /** Provider Adapter 负责wire追加和SDK协议；branch使用独立continuation，绝不提交主Run续接。 */
  complete(input: BranchInput<Wire> & {
    scenario: BranchName
    outputMode: 'text' | 'json'
    maxOutputTokens: number
    cacheSingleflight: boolean
  }, signal?: AbortSignal): Promise<{
    output: Json
    usage: Json
  }>
  isInputRejected(error: unknown): boolean
}

export interface BranchPorts<Wire> extends ContextServices {
  provider: BranchProviderPort<Wire>
  pauseBeforeRetry(attempt: number, signal?: AbortSignal): Promise<void>
  /** 原始异常只交给受限诊断端口；可见消息由Host统一脱敏。 */
  diagnostic(error: unknown, metadata: {
    branch: BranchName
    runFingerprint: string
    attempt: number
  }): void
}

export interface CanonicalFinalizationPort {
  complete(input: CanonicalCompletionInput): Promise<void>
}

export interface ReflectionFinalizationPorts {
  snapshots: ReflectionSnapshots<unknown>
  projection: ReflectionProjectionPort<unknown>
  /** 只能读取可信Host/会话策略；群成员受限状态不能由模型字段扩大。 */
  policy(identity: RunIdentity): Promise<{
    enabled: boolean
    scope: 'owner' | 'group' | 'member'
  }>
  /** 只唤醒已在成功history事务登记的独立Job，不在此创建不可靠的第二份任务。 */
  notifyReady(input: {
    identity: RunIdentity
    accessScopeHash: string
    scope: 'owner' | 'group' | 'member'
    snapshotDigest: string | null
    recovery: 'reuse' | 'rebuild' | 'defer'
    hadTools: boolean
  }): Promise<void>
}

export interface StreamSanitizer {
  feed(text: string): string
  flush(): string
  checkpoint?(): SanitizerCheckpoint
  /** 引用由安全Adapter归属到该run/round，原始缓冲文本不进入RunStore。 */
  restore?(checkpoint: Extract<SanitizerCheckpoint, {
    kind: 'reference'
  }>, scope: {
    readonly identity: RunIdentity
    readonly round: number
  }): Promise<void>
}

/**
 * Adapter必须在事务内检查owner、version、lease fencing，原子提交全部字段。
 * calls/inflight/待交互中的input及rawArguments是保密执行意图，可能包含用户显式请求头；
 * Data/Tools必须加密受限保存或使用安全意图引用，状态DTO/日志不得原样公开。
 * 不可用redact修改实际dispatch参数假装完成该存储边界；内存测试Adapter不构成生产验收。
 */
export interface RunStore<C> {
  read(identity: RunIdentity): Promise<RunCheckpoint<C> | null>
  create(checkpoint: RunCheckpoint<C>, lease: Lease, events: readonly RunEvent[]): Promise<void>
  commit(change: {
    readonly identity: RunIdentity
    readonly expectedVersion: number
    readonly lease: Lease
    readonly checkpoint: RunCheckpoint<C>
    readonly events: readonly RunEvent[]
    /**
     * null只保存Run checkpoint/outbox，不物化Canonical历史或summary baseline。
     * success同事务应用Canonical delta、usage及C中的pending compaction；
     * interruption仅中断delta，不前移summary水位；failed不写history/effects。
     */
    readonly history: {
      readonly outcome: 'success' | 'interruption' | 'silent'
      readonly context: C
      readonly text: string
    } | null
    /** 与新 checkpoint 同事务消费，禁止同一回答重放。 */
    readonly interactionReceipt: string | null
  }): Promise<void>
  /** 查询已提交 outbox；发布失败后下次恢复可补送，不重新执行业务。 */
  pendingEvents(identity: RunIdentity): Promise<readonly RunEvent[]>
  acknowledgeEvents(identity: RunIdentity, ids: readonly string[]): Promise<void>
}

export interface LeasePort {
  /** 同一owner/session跨run互斥；acquire开始续租，release停止续租，assert验证fence未失效。 */
  acquire(identity: RunIdentity): Promise<Lease | null>
  assert(identity: RunIdentity, lease: Lease): Promise<void>
  release(identity: RunIdentity, lease: Lease): Promise<void>
}

export interface CancellationPort {
  isRequested(identity: RunIdentity): Promise<boolean>
  /** durable marker 必须先于 notify；所有检查都须绑定 owner + run，不能只按 session。 */
  request(identity: RunIdentity): Promise<void>
  notify(identity: RunIdentity): Promise<void>
  /** 一个 run 只订阅一次；dispose 必须移除监听。 */
  subscribe(identity: RunIdentity, listener: () => void): Promise<() => void>
}

export interface ProviderPort<C> {
  stream(request: ProviderRequest<C>): AsyncIterable<ProviderEvent>
  /** 中断的远端请求只有 Adapter 能确定如何续接；不提供时不能自动重发。 */
  recover?(request: ProviderRequest<C>, boundary: ProviderRecoveryBoundary): Promise<NormalizedProviderRecovery | null>
}

export interface ContextPort<C> {
  /** 验证嵌套canonical身份；外层checkpoint身份不能为内部Context背书。 */
  assertIdentity(identity: RunIdentity, context: C): void
  checkpointToolResult(scope: {
    readonly identity: RunIdentity
    readonly round: number
    readonly call: ToolCall
  }, result: ToolResult, signal?: AbortSignal): Promise<ToolResult>
  restoreToolResult(scope: {
    readonly identity: RunIdentity
    readonly round: number
    readonly call: ToolCall
  }, result: ToolResult, signal?: AbortSignal): Promise<ToolResult>
  /** 必须在返回前关闭短事务，不跨 Provider 等待持有数据库连接。 */
  prepare(identity: RunIdentity, signal: AbortSignal): Promise<C | EarlyExit>
  afterRound(context: C, result: {
    readonly text: string
    readonly calls: readonly ToolCall[]
    readonly continuation?: unknown
    readonly cacheAnchor?: unknown
    readonly contextInput?: number | null
  }, round: number): Promise<C>
  afterTool(context: C, call: ToolCall, result: ToolResult, round: number): Promise<C>
  resumeInteraction(context: C, pending: PendingInteraction, resolution: InteractionResolution): Promise<C>
  recoverOverflow(context: C, attempt: number, signal: AbortSignal): Promise<{
    readonly context: C
    readonly applied: boolean
  }>
  /** 在 actual usage 达 85% 时的压缩编排；用量未知不触发。 */
  afterUsage(context: C, usage: Usage, signal: AbortSignal): Promise<{
    readonly context: C
    readonly applied: boolean
  }>
  appendReminder?(context: C, prompt: string): Promise<C>
  release?(identity: RunIdentity): Promise<void>
  /**
   * 成功提交后捕获本进程主请求快照并安排标题/摘要/反思；不得重跑业务写入。
   * 可靠Job计划必须由RunStore.history同事务写outbox，此处只做进程快照/通知。
   */
  afterFinal?(identity: RunIdentity, context: C, outcome: {
    readonly status: 'completed'
    readonly text: string
    readonly roundTexts: readonly string[]
    readonly usage: Usage
    readonly hadTools: boolean
    readonly displayTimeline: readonly DisplayItem[]
  }): Promise<void>
}

export interface ExecutionPort {
  execute(scope: RunIdentity & {
    readonly roundId: string
    readonly toolCallId: string
  }, request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult>
}

export interface ToolPort {
  /** 可信注册表逐项区分交互/审批；普通同轮调用并行，isolated结果不进入dispatch。 */
  plan?(calls: readonly ToolCall[], identity: RunIdentity): Promise<ToolPlan>
  /** 注册表、权限与 confirm 在调用前检查；通过该参数使用共用 Executor。signal取消后须等待已启动资源清理再settle。提交/远端结果未知必须return unknown，不能抛普通工具错误。 */
  dispatch(call: ToolCall, scope: {
    readonly identity: RunIdentity
    readonly roundId: string
    readonly signal: AbortSignal
    readonly execute: (request: ExecutionRequest) => Promise<ExecutionResult>
    readonly resolution: InteractionResolution | null
  }): Promise<ToolResult>
  /** 跨进程恢复只查已提交操作收据；未知结果必须明确返回 unknown。 */
  reconcile(call: ToolCall, identity: RunIdentity & {
    readonly roundId: string
  }): Promise<ToolResult>
}

export interface InteractionPort {
  /** 按request.id幂等激活；仅当此门轮到前台时创建/刷新授权prompt，不预激活整批。 */
  activate(identity: RunIdentity, request: PendingInteraction, signal: AbortSignal): Promise<PendingInteraction>
}

export interface ReplyPolicy<C> {
  /** 语言规则、群回复门/verify 等由策略注入，编排和次数限制留在 Harness。 */
  evaluate(text: string, context: C): Promise<'accept' | 'retry' | 'silent'>
  classify?(text: string, context: C, roundFacts?: {
    readonly requiresTools?: boolean
  }): Promise<ReplyFacts>
}

export interface HarnessPorts<C> {
  readonly clock: {
    now(): string
  }
  readonly store: RunStore<C>
  readonly leases: LeasePort
  readonly cancellation: CancellationPort
  readonly provider: ProviderPort<C>
  readonly context: ContextPort<C>
  readonly tools: ToolPort
  readonly interactions: InteractionPort
  readonly execution: ExecutionPort
  readonly reply: ReplyPolicy<C>
  /** 只做注册表/别名归一，不能把模型工具字段当授权；gate编排在Harness。 */
  readonly replyGate?: {
    classifyCall(context: C, call: ToolCall): Promise<ReplyGateCall>
  }
  /** 完成解析/协议清洗由安全适配器承担，不记录原始上游异常。 */
  readonly sanitizeText: (text: string) => string
  readonly createStreamSanitizer: (scope?: {
    readonly identity: RunIdentity
    readonly round: number
  }) => StreamSanitizer
  readonly presentError: (error: unknown) => {
    readonly code: string
    readonly text: string
  }
  /** 可信业务投影只返回可展示的结果；凭据/私有协议材料不得进入返回值。 */
  readonly presentToolResult: (value: unknown, scope: {
    readonly identity: RunIdentity
    readonly round: number
    readonly call: ToolCall
  }) => Promise<unknown>
  readonly publish: (event: RunEvent, signal?: AbortSignal) => Promise<void>
  readonly diagnose: (code: 'publish_failed' | 'release_failed' | 'unsubscribe_failed' | 'context_release_failed' | 'finalization_hook_failed') => void
}

/** 单Run模块协作端口；实现仅持有同一份状态、提交器和已启动操作集合。 */
export interface RunCoordination<C> {
  ports: HarnessPorts<C>; identity: RunIdentity; controller: AbortController; state: RunCheckpoint<C> | undefined; lease: Lease | null; finalized: boolean; persistenceUncertain: boolean; dispatchedCalls: Set<string>; uncertainExecutions: Set<string>; dispatchKey(call: ToolCall): string
  commit(patch: Partial<RunCheckpoint<C>>, type?: RunEvent['type'], payload?: Readonly<Record<string, unknown>>, history?: {
    readonly outcome: 'success' | 'interruption' | 'silent'
    readonly context: C
    readonly text: string
  } | null, interactionReceipt?: string | null): Promise<RunEvent | null>
  checkCancellation(): Promise<void>
  finish(status: 'completed' | 'cancelled' | 'failed' | 'unknown', code: string | null, text: string, silent?: boolean): Promise<RunEvent>
  executeTool(call: ToolCall, resolving: InteractionResolution | null, signal?: AbortSignal, waitForCleanup?: boolean): Promise<ToolResult>
  applyTool(call: ToolCall, result: ToolResult, advance?: boolean, consumeInteractionId?: string): Promise<RunEvent>
  activateNextInteraction(): Promise<RunEvent | null>
  closeInteractions(status: 'cancelled' | 'error', additional?: readonly import("./index.js").PendingInteraction[]): AsyncGenerator<RunEvent>
  completeResolutionClosure(): AsyncGenerator<RunEvent>
  parallelBatch(calls: readonly ToolCall[], limit: number): AsyncGenerator<RunEvent, readonly DispatchOutcome<ToolResult>[]>
  encodeResult(call: ToolCall, result: ToolResult, round?: number): Promise<ToolResult>
  hydrateResult(call: ToolCall, result: ToolResult): Promise<ToolResult>
  cacheResult(call: ToolCall, result: ToolResult, replay?: boolean): Promise<ToolResult>
  stoppedResult(call: ToolCall, status: 'cancelled' | 'deferred'): ToolResult
  closeTools(currentStatus: 'cancelled' | 'error', remainingStatus: 'cancelled' | 'deferred'): AsyncGenerator<RunEvent>
}
