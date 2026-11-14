
import type { groupHistoryUnits,MessageArea } from './history/canonical-history.js'
import type { ContextServices } from './ports.js'

export type MessageSource = 'restored_history' | 'user' | 'rag' | 'stance' | 'message_time' | 'runtime' | 'reference' | 'attachment' | 'tool_round' | 'agent_followup' | 'unknown'

export type PersistencePolicy = 'already_persisted' | 'commit_on_success' | 'commit_on_interruption' | 'request_only' | 'reconstruct_on_restore'

export interface EntryInput {
  message: CanonicalMessage
  source?: MessageSource
  persistencePolicy?: PersistencePolicy
  batchId?: string | null
  roundId?: string | null
  persistedMessageId?: string | null
}

export interface MessageEntry extends EntryInput {
  entryId: string
  sequence: number
  revision: number
  source: MessageSource
  persistencePolicy: PersistencePolicy
}

export interface CanonicalAreaSnapshot {
  entries: MessageEntry[]
  revision: number
  digest: string
  batches: {
    batchId: string
    metadata: Record<string, Json>
  }[]
  checkpointDigest: string
}

export interface ProjectionIdentity {
  areaRevision: number
  areaDigest: string
  entryCount: number
  prefixDigest: string
  modelIdentity: string
}

export interface OpaqueProviderProjection<Wire> extends ProjectionIdentity {
  /** Wire 只能交给同协议 Provider，不得反向当作 Canonical。 */
  wire: Wire
  dynamicTailSize: number
}

export interface PersistenceDelta {
  entries: MessageEntry[]
  revision: number
  digest: string
  batches: {
    batchId: string
    entries: MessageEntry[]
    metadata: Record<string, Json>
    digest: string
  }[]
  userAnchorSequence: number | null
}

/** Canonical 层只持有语义和稳定引用，不持有 Provider wire、授权材料或数据库连接。 */
export type Json = null | boolean | number | string | Json[] | {
  [key: string]: Json
}

export type Block = {
  type: string;
  [key: string]: Json
}

export interface CanonicalMessage {
  role: string
  content: Json
  [key: string]: Json
}

export interface HistoryEnvelope {
  schemaVersion: 1
  role: string
  contentBlocks: Block[]
  quote: Block | null
  attachments: Block[]
  sender: {
    id: string | null
    name: string | null
  } | null
  sentAt: string | null
  source: string | null
  unknownBlockCount: number
}

export interface CanonicalContext {
  staticSystem: CanonicalMessage[]
  sessionSnapshot: CanonicalMessage[]
  canonicalHistory: CanonicalMessage[]
  currentTurn: CanonicalMessage[]
  historyUnits: ReturnType<typeof groupHistoryUnits>
}

export interface CanonicalToolCall {
  id: string
  name: string
  input: Json
  rawArguments?: string
  responsesItemId?: string
}

export type PortableValue = null | boolean | number | string | readonly PortableValue[] | {
  readonly [key: string]: PortableValue
}

export interface HistoryIdentity {
  ownerId: string
  sessionId: string
}

export interface PersistedHistoryRow extends HistoryIdentity {
  id: string
  conversationSeq: number
  historyAnchorSeq?: number | null
  role: string
  content: Json
  contentJson?: Json
  coversUntilSeq?: number | null
  runId?: string | null
  roundId?: string | null
  canonicalBatchId?: string | null
  platformSentMs?: number | null
  eventReceivedMs?: number | null
  createdAt?: string | null
  sentAt?: string | null
  quote?: string | null
  files?: Json[]
  senderId?: string | null
  senderName?: string | null
  source?: string | null
  chatType?: string | null
  /** 只读入本Run内存的首发完整图片投影，不属于持久Canonical正文。 */
  providerImageContent?: Block[]
}

export interface HistoryRenderOptions {
  groupChat?: boolean
  userTimezone?: string
  allowHistoricalImages?: boolean
  formatMessageTime?: (timestamp: string | number, timezone: string) => string
}

export interface PreparedContextCheckpoint extends HistoryIdentity {
  schemaVersion: 1
  area: CanonicalAreaSnapshot
  protectedHistoryStart: number | null
  requestPrefixSize: number
  stanceToPersist: string | null
  digest: string
}

export interface ToolResultCheckpointScope {
  readonly identity: RunIdentity
  readonly round: number
  readonly call: ToolCall
}

export interface ScopeMarker {
  ownerId: string
  sessionId: string
  runId: string
  round: number
  callId: string
  toolName: string
  callDigest: string
}

export interface Capsule {
  type: 'harness-tool-result-checkpoint'
  schemaVersion: 1
  scope: ScopeMarker
  controlDigest: string
  payloadDigest: string
  payload: Json
}

export type Digests = Pick<ContextServices, 'digest'>

export interface RagContext {
  tail: CanonicalMessage[]
  [key: string]: unknown
}

export interface CurrentUser {
  message: CanonicalMessage
  persistedMessageId?: string | null
  /** 真实请求原文；优先用于RAG，不把图文投影中的引用/附件/系统补充当作查询。 */
  rawText?: string
  /** 由注入的时区格式化器生成；不是当前墙钟时间。 */
  messageTime?: string | null
}

export interface PrepareContextInput extends HistoryIdentity {
  /** 定时任务没有会话历史/RAG，任务输入仅参与本次请求。 */
  entryKind?: 'interactive' | 'scheduled_task'
  history: readonly PersistedHistoryRow[]
  fixedPrefix: readonly CanonicalMessage[]
  systemPrompt?: string
  systemInMessages?: boolean
  currentUser?: CurrentUser
  currentUsers?: readonly CurrentUser[]
  currentUsersInHistory?: boolean
  resumeInteraction?: boolean
  stance?: string | null
  previousStanceDigest?: string | null
  query?: string
  groupChat?: boolean
  userTimezone?: string
  allowHistoricalImages?: boolean
  /** 来自可信Tools registry的当前模型schema，只追加request-only更新，不重写历史声明。 */
  latestToolSchemas?: readonly Block[]
  extraReminder?: string | null
  preparedRag?: RagContext
  snapshotText?: string
}

export interface PreparedContext {
  area: MessageArea
  rag: RagContext
  stanceToPersist: string | null
  protectedHistoryStart: number | null
}

/** 可序列化的运行状态；Provider wire/私有推理只经独立端口保存。 */
export interface CanonicalHarnessContext {
  readonly identity: RunIdentity
  readonly modelIdentity: string
  readonly accessScopeHash: string
  /** 标准准备链冻结的公开能力；低层自定义load自行承担同等准备契约。 */
  readonly capabilities: RunCapabilities | null
  readonly replyContext: {
    readonly userRequest: string
    readonly locale: string
    readonly decisionGuardEnabled: boolean
  }
  readonly contextWindow: number
  readonly prepared: PreparedContextCheckpoint
  /** 非敏感稳定标识；Data Adapter 与 checkpoint 同事务接收独立加密推理记录。 */
  readonly continuationRef: string | null
  readonly pendingRound: {
    readonly round: number
    readonly text: string
    readonly calls: readonly CanonicalToolCall[]
    readonly dispatched: readonly {
      callId: string
      content: Json
      isError?: boolean
      toolName?: string
    }[]
    readonly assistantEntryId: string | null
    readonly resultEntryId: string | null
  } | null
  readonly failedCompactionInput: number | null
  /** 最近这一次完整Provider请求的实际输入；缺报即null，不能借前轮或peak补值。 */
  readonly currentProviderInput: number | null
  readonly sourceEffects: CanonicalSourceEffects | null
  /** 仅稳定指纹元数据；Data在success/silent收尾事务中更新session anchor。 */
  readonly providerCacheAnchor: {
    readonly ownerId: string
    readonly sessionId: string
    readonly modelIdentity: string
    readonly anchor: {
      provider: string
      api_format: string
      model: string
      strategy: string
      baseline_digest: string
    }
  } | null
  /** 待收尾的压缩候选；Data仅在history.outcome=success时按id同事务应用，失败/中断不推进摘要水位。 */
  readonly compactions: readonly {
    readonly id: string
    readonly result: CompactionResult
  }[]
}

export type CanonicalSourceEffects = ContextSourceEffects

export interface FrozenProviderRequest {
  readonly accessScopeHash: string
  readonly sourceCheckpointDigest: string
  readonly area: CanonicalAreaSnapshot
  readonly requestPrefix: CanonicalMessage[]
  readonly dynamicTail: CanonicalMessage[]
  readonly projection: OpaqueProviderProjection<unknown>
  readonly systemPrompt: string
  readonly tools: Json[]
}

export interface ContextData {
  projects: Json
  userTimezone: string
  events: Json
  notes: Json
  filesOverview: Json
  stylePreferences: Json
  memory: Json
  imChannels: Json
  imMemory: Json
  knowledge: Json
}

export interface ContextLoadPolicy {
  loadOwnerContext: boolean
  memoryEnabled: boolean
}

export interface ContextSourceSelection {
  modelIdentity: string
  contextWindow: number
  locale: string
  groupChat: boolean
  workspaceBinding: Record<string, Json> | null
  contextPolicy: ContextLoadPolicy
  allowHistoricalImages?: boolean
  /** 由可信Host按platform/bot/chat/actor或MemoryScope生成，不能使用模型/消息正文中的scope声明。群请求必须显式提供。 */
  contextScopeKey?: string
}

export type CurrentTurnSources = Pick<PrepareContextInput, 'currentUser' | 'currentUsers' | 'currentUsersInHistory' | 'resumeInteraction' | 'stance' | 'previousStanceDigest' | 'extraReminder' | 'preparedRag' | 'query'>

export interface ContextSourceEffects {
  /** Data Adapter在首次prepared checkpoint commit（prev.context=null）同一事务内按owner+expectedEpoch CAS应用；后续token提交不得重复应用，不可提前单独commit。 */
  sessionSnapshot: {
    expectedEpoch: number
    state: SessionSnapshotState
    phase: 'hit' | 'rebuild'
  }
}

export interface CanonicalSourceLoaderResult {
  input: PrepareContextInput
  modelIdentity: string
  contextWindow: number
  sourceEffects: ContextSourceEffects
}

export interface SessionSnapshotState extends HistoryIdentity {
  contextEpoch: number
  context: Record<string, Json> | null
  snapshotHash: string | null
  sessionInfoHash: string | null
  snapshotExpiresAt: number | null
  baselineMessageSeq: number
}

export interface SnapshotPayload {
  systemPrompt: string
  snapshotContext: string
  sessionInfo: Record<string, Json>
  userTimezone: string
  locale?: string
  imChannels?: Record<string, Json>
  imMemory?: Record<string, Json>
  memorySummaryHash?: string
  coveredMessages?: readonly CanonicalMessage[]
}

export interface PreparationIdentity {
  readonly ownerId: string
  readonly subject: {
    readonly kind: 'session' | 'scheduled_task'
    readonly id: string
  }
  readonly workspaceId: string | null
}

export interface CapabilityCatalog {
  readonly metadataOnly: boolean
  readonly toolCatalog: string
  readonly skillCatalog: string
  /** Tools提供的完整公开用户Skill元数据，首次冻结到session候选；空数组也必须明确返回。 */
  readonly userSkills: readonly Json[]
}

export interface PreparedToolDefinition {
  readonly name: string
  /** 可信registry提供的稳定公开Schema；不得包含handler、凭据或临时媒体URL。 */
  readonly schema: {
    readonly [key: string]: Json
  }
}

export interface RunCapabilities {
  readonly toolNames: readonly string[]
  readonly tools: readonly PreparedToolDefinition[]
  readonly subject?: PreparationIdentity
  readonly userSkillSnapshot?: readonly Json[]
}

export interface ProviderUsage {
  requestId: string
  modelIdentity: string
  freshInput: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

export interface ProtectedWindow {
  from?: number | null
  anchorIndex?: number | null
  previousFrom?: number | null
}

export interface BudgetResult {
  changed: boolean
  droppedMessages: number
  protectedStartIndex?: number
  anchorIndex?: number
  protectedSourceStartIndex?: number
  previousProtectedStartIndex?: number
}

export interface CompactionSummaryInput<Wire> {
  history: CanonicalMessage[]
  compressible: CanonicalMessage[]
  previousSummary: string | null
  requestPrefix?: CanonicalMessage[]
  /** 精确匹配时保留原始 wire；Adapter 只能追加压缩任务，不重新渲染这段前缀。 */
  projection: OpaqueProviderProjection<Wire> | null
  preserveLatestUser: boolean
}

export interface CompactionResult {
  changed: boolean
  reason: 'compacted' | 'no_compressible_history' | 'protected_anchor_missing' | 'summary_validation_failed' | 'shape_validation_failed'
  messages: CanonicalMessage[]
  expectedRevision: number
  protectedStartIndex: number | null
  anchorIndex: number | null
  previousProtectedStartIndex: number | null
  /** Data Adapter 在同一事务写摘要和水位；未知提交结果不能自动重放。 */
  coversUntilMessageIds: string[]
  summarySource?: 'provider' | 'emergency'
}

export interface SummaryGenerationConfig extends Omit<BranchInput<never>, 'projection' | 'canonicalHistory' | 'delta'> {
  contextTokens: number
  maxOutputTokens: number
  instruction: string
}

export interface ReflectionSnapshot<Wire> extends HistoryIdentity {
  runId: string
  modelIdentity: string
  accessScopeHash: string
  systemPrompt: string
  tools: Json[]
  projection: OpaqueProviderProjection<Wire>
  persistedMessageIds: string[]
  persistedPrefix: {
    id: string
    sequence: number
    messageDigest: string
  }[]
  providerContextInput: number | null
  providerCompacted: boolean
  createdAt: number
  digest: string
  source: 'in_memory' | 'in_memory_extended' | 'persisted_history'
}

export interface ReflectionPreparationInput extends HistoryIdentity {
  modelIdentity: string
  bufferedSessionIds: readonly (string | null)[]
  scope: 'owner' | 'group' | 'member'
  contextWindow: number
  reason: 'idle' | 'context-pressure' | 'compacted'
  allowOwnerIdleRebuild?: boolean
  accessScopeHash?: string | null
}

export type BranchName = 'compaction' | 'reflection' | 'reflection-preview' | 'knowledge'

export interface BranchInput<Wire> extends HistoryIdentity {
  runId: string | null
  stableSystem: string
  delta: string
  tools: Json[]
  scope?: string
  scopeRevision?: string | null
  projection?: OpaqueProviderProjection<Wire> | null
  canonicalHistory?: CanonicalMessage[]
}

export interface BranchPolicy {
  name: BranchName
  outputMode?: 'text' | 'json'
  maxRetries?: number
  maxOutputTokens?: number
}

export interface BranchResult {
  ok: boolean
  output: Json
  reason: 'completed' | 'provider_error' | 'output_empty' | 'schema_invalid'
  attempts: number
  contextOverflow: boolean
  providerErrorCode: string | null
  inputFingerprint: string
  outputFingerprint: string | null
  usage: Json
  metadata: {
    branch: BranchName
    mode: 'append_reuse'
    scope: string
    scopeRevision: string | null
    sessionId: string
    runId: string | null
  }
}

export interface CanonicalCompletionInput {
  identity: RunIdentity
  modelIdentity: string
  accessScopeHash: string
  request: PreparedContext | null
  projection: OpaqueProviderProjection<unknown> | null
  requestSystemPrompt: string
  requestTools: Json[]
  text: string
  providerContextInput: number | null
  providerCompacted: boolean
  hadTools: boolean
}

export interface ReplyState {
  readonly emptyRetries: number
  readonly anyToolCalled: boolean
  readonly narrationRetries: number
  readonly decisionRetries: number
  readonly intentRetries: number
  readonly colonRetries: number
  readonly toolIntentRetries: number
  readonly guardPending: boolean
  readonly colonPending: boolean
}

export interface ReplyFacts {
  readonly empty: boolean
  readonly narration: boolean
  readonly announcesIntent: boolean
  readonly endsWithColon: boolean
  readonly toolProgressOnly: boolean
  readonly requiresTools: boolean
  readonly decisionDodge: boolean
  readonly decisionGuardEnabled: boolean
  readonly prompts: {
    readonly narration: string
    readonly intent: string
    readonly colon: string
    readonly tools: string
    readonly decision: string
  }
  readonly emptyFallback: string
}

export interface ReplyDecision {
  readonly state: ReplyState
  readonly action: 'retry' | 'complete'
  readonly retryKind?: 'empty' | 'guard'
  readonly prompt?: string
  /** null表示守卫重试不把未交付内容伪装成最后成功回复。 */
  readonly visible: 'original' | 'suppressed' | 'fallback'
}

export type ReplyChoice = 'disabled' | 'pending' | 'reply' | 'silent'

export type ReplyGateCall = 'decline' | 'business' | 'invalid'

/** 语言规则仅描述文字行为，不携带用户权限或工具授权事实。 */
export interface GuardLocale {
  readonly locale: 'zh-CN' | 'en-US' | 'ja-JP'
  readonly narration: RegExp
  readonly actionRequest: RegExp
  readonly refusal: RegExp
  readonly intent: RegExp
  readonly question: RegExp
  readonly toolProgressPrefixes: readonly string[]
  readonly prompts: {
    readonly narration: string
    readonly intent: string
    readonly decision: string
    readonly tools: string
    readonly colon: string
  }
}

export interface ReplyClassificationContext {
  readonly userRequest: string
  readonly locale?: string | null
  /** 只接收Provider adapter归一化的运行时事实，不能写入Canonical正文。 */
  readonly requiresTools?: boolean
  /** 只接收用户明确选择的偏好；默认关闭，不能从文本反推。 */
  readonly decisionGuardEnabled?: boolean
}

export interface RunHarness<C> {
  start(identity: RunIdentity, options?: {
    readonly scheduled?: boolean
    readonly anchorMessageId?: string
    readonly goalMode?: boolean
    readonly replyChoice?: 'pending' | 'reply'
  }): AsyncGenerator<RunEvent, RunCheckpoint<C>>
  resume(identity: RunIdentity, resolution?: InteractionResolution): AsyncGenerator<RunEvent, RunCheckpoint<C>>
  cancel(identity: RunIdentity): Promise<boolean>
  /** 只重送已提交 outbox，不启动 Provider 或执行工具。 */
  replay(identity: RunIdentity, options?: {
    readonly signal?: AbortSignal
  }): AsyncGenerator<RunEvent>
}

export interface DisplayItem {
  readonly eventId: string
  readonly kind: 'assistant' | 'tool'
  readonly runId: string
  readonly roundId: string
  readonly sequence: number
  readonly anchorMessageId: string | null
  readonly timelineOrder: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly text?: string
  readonly files?: readonly unknown[]
  readonly linkButtons?: unknown
  readonly toolCallId?: string
  readonly toolName?: string
  readonly toolStatus?: string
  readonly toolResult?: unknown
}

export type DispatchOutcome<T> = {
  readonly status: 'completed'
  readonly value: T
} | {
  readonly status: 'error'
  readonly error: unknown
} | {
  readonly status: 'cancelled'
} | {
  readonly status: 'deferred'
}

/** 身份由 Host 注入；模型输出不参与 owner/session/run 的解析。 */
export interface RunIdentity {
  readonly ownerId: string
  readonly sessionId: string
  readonly runId: string
}

export type RunStatus = 'preparing' | 'running' | 'waiting' | 'completed' | 'cancelled' | 'failed' | 'unknown'

export interface EarlyExit {
  readonly kind: 'early_exit'
  readonly reason: 'attachment_claim_failed' | 'quota_exhausted' | 'voice_unsupported' | 'provider_error'
  readonly response: {
    readonly text: string
    readonly errored?: boolean
    readonly errorCode?: string
  }
}

export function isEarlyExit(value: unknown): value is EarlyExit {
  if (!value || typeof value !== 'object')
    return false
  const candidate = value as Partial<EarlyExit>
  return candidate.kind === 'early_exit' && ['attachment_claim_failed', 'quota_exhausted', 'voice_unsupported', 'provider_error'].includes(candidate.reason ?? '') && !!candidate.response && typeof candidate.response.text === 'string' && (candidate.response.errored === undefined || typeof candidate.response.errored === 'boolean')
}

export interface Usage {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /** 同一请求实际输入，包含缓存；缺失时不得估算。 */
  readonly contextInput: number | null
}

export interface ProviderCursor {
  /** 归一流内的连续序号，不是run级事件序号。 */
  readonly sequence: number
  /** 仅稳定、非敏感的重放引用；凭据/原生私有块须在Provider安全存储。 */
  readonly reference: string | null
}

export type SanitizerCheckpoint = {
  readonly kind: 'clean'
} | {
  readonly kind: 'unavailable'
} | {
  readonly kind: 'reference'
  readonly reference: string
}

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly input: unknown
  readonly rawArguments?: string
  readonly responsesItemId?: string
  /** Provider 已确认参数不是合法对象；保留调用以反馈模型，禁止派发空参数。 */
  readonly parseError?: 'invalid_json' | 'not_object'
}

/** 首轮模型实际消费的内联图片；由Harness校验revision并修订Canonical，Provider不改ledger。 */
export interface ConsumedInitialMedia {
  readonly expectedRevision: number
  readonly entryIds: readonly string[]
}

export interface PendingInteraction {
  readonly id: string
  readonly kind: 'question' | 'confirmation' | 'credential'
  readonly toolCall: ToolCall
  readonly afterConfirmation?: boolean
}

/** 由交互服务完成owner/单次消费/授权后的收据。credential正文必须先写安全存储，value不作为Canonical或Tools凭据传递。 */
export interface InteractionResolution {
  readonly interactionId: string
  readonly receiptId: string
  readonly status: 'answered' | 'confirmed' | 'cancelled' | 'aborted' | 'expired'
  readonly value: unknown
}

export interface ResolutionClosure {
  readonly disposition: 'cancelled' | 'aborted' | 'expired'
  readonly pending: PendingInteraction
  readonly closingRound: number
  readonly step: 'close_tools' | 'start' | 'text' | 'end' | 'final'
}

/** executed=false表示未实际调用handler；仅取消/延后跳过Canonical，明确协议/权限拒绝仍需回执。 */
export type ToolResult = {
  readonly kind: 'completed'
  readonly value: unknown
  readonly successful: boolean
  readonly mutated: boolean
  readonly artifact?: unknown
  readonly executed?: boolean
  readonly canonicalEvents?: readonly unknown[]
} | {
  readonly kind: 'waiting'
  readonly interaction: PendingInteraction
} | {
  readonly kind: 'unknown'
}

/** wire/thinking/signature 的解释属于 Provider；Harness 只消费归一化事件。 */
export type ProviderEvent = {
  readonly cursor?: ProviderCursor
} & ({
  readonly type: 'token'
  readonly text: string
} | {
  readonly type: 'usage'
  readonly usage: Usage
} | {
  readonly type: 'diagnostic'
  readonly data: unknown
} | {
  readonly type: 'retry'
  readonly attempt: number
  readonly maxRetries: number
  readonly nextRetryMs: number
  readonly errorCode: string
} | {
  readonly type: 'complete'
  readonly text: string
  readonly calls: readonly ToolCall[]
  readonly continuation?: unknown
  readonly cacheAnchor?: unknown
  readonly consumedInitialMedia?: ConsumedInitialMedia
  readonly finishReason?: string | null
  readonly incompleteReason?: string | null
  readonly requiresTools?: boolean
} | {
  readonly type: 'error'
  readonly error: unknown
  readonly contextOverflow?: boolean
})

export interface RunEvent {
  readonly id: string
  readonly identity: RunIdentity
  readonly sequence: number
  readonly round: number
  readonly type: 'run_started' | 'round_start' | 'token' | 'round_end' | 'tool_call' | 'tool_done' | 'interaction_required' | 'interaction_resolved' | 'compaction' | 'provider_diagnostic' | 'retry' | 'run_resumed' | 'final'
  readonly payload: Readonly<Record<string, unknown>>
}

export interface RunCheckpoint<C> {
  readonly identity: RunIdentity
  readonly version: number
  readonly sequence: number
  readonly status: RunStatus
  readonly phase: 'prepare' | 'provider' | 'tools' | 'decision' | 'idle'
  readonly round: number
  readonly context: C | null
  readonly text: string
  readonly roundTexts: readonly string[]
  readonly displayTimeline: readonly DisplayItem[]
  readonly anchorMessageId: string | null
  readonly usage: Usage
  readonly totalUsage: Usage
  readonly usageAppliedRound: number
  readonly providerCursor: ProviderCursor | null
  readonly sanitizerCheckpoint: SanitizerCheckpoint
  readonly mutated: boolean
  readonly unpersistedToolResult: {
    readonly callId: string
    readonly successful: boolean
    readonly mutated: boolean
  } | null
  readonly files: readonly unknown[]
  readonly providerRounds: readonly Readonly<Record<string, string | number | null>>[]
  readonly calls: readonly ToolCall[]
  readonly callIndex: number
  /** 已派发、尚未得到确定回执的调用；恢复时只允许 reconcile，不重放。 */
  readonly inflightCall: ToolCall | null
  readonly inflightCalls: readonly ToolCall[]
  readonly parallelLimit: number | null
  readonly pending: PendingInteraction | null
  readonly queuedInteractions: readonly PendingInteraction[]
  readonly replayCall: ToolCall | null
  readonly replayResultReady: boolean
  readonly toolResults: readonly {
    readonly callId: string
    readonly result: ToolResult
  }[]
  readonly toolsDispatched: boolean
  readonly parallelCallIds: readonly string[]
  readonly serialCallIds: readonly string[]
  readonly isolatedCallIds: readonly string[]
  readonly resolution: InteractionResolution | null
  readonly resolutionClosure: ResolutionClosure | null
  readonly emptyRetries: number
  readonly replyState: ReplyState
  readonly overflowRetries: number
  readonly overflowRecoveryPending: boolean
  readonly maxRounds: number | null
  readonly goalMode: boolean
  readonly replyChoice: ReplyChoice
  readonly roundRequiresTools: boolean
  readonly completedToolCount: number
  readonly remoteStatusUnknown: boolean
  readonly errorCode: string | null
  readonly earlyExitReason: EarlyExit['reason'] | null
}

export interface Lease {
  readonly token: string
  readonly fence: number
}

export interface ProviderRequest<C> {
  readonly identity: RunIdentity
  readonly round: number
  readonly context: C
  readonly signal: AbortSignal
  readonly replyChoice: ReplyChoice
}

export interface ProviderRecoveryBoundary {
  readonly identity: RunIdentity
  readonly round: number
  readonly runSequence: number
  readonly roundText: string
  readonly cursor: ProviderCursor | null
  readonly sanitizer: SanitizerCheckpoint
}

export interface NormalizedProviderRecovery {
  /** Adapter确认恰好此边界；流只从该边界后续接，不能自行重发整个请求。 */
  readonly boundary: ProviderRecoveryBoundary
  readonly stream: AsyncIterable<ProviderEvent>
}

export type ToolPlan = {
  readonly mode: 'serial'
  readonly isolatedResults?: readonly {
    readonly callId: string
    readonly result: ToolResult
  }[]
} | {
  readonly mode: 'parallel'
  readonly maxConcurrency: number
  readonly serialCallIds?: readonly string[]
  readonly isolatedResults?: readonly {
    readonly callId: string
    readonly result: ToolResult
  }[]
}

export class HarnessError extends Error {
  constructor(readonly code: 'not_found' | 'conflict' | 'lease_lost' | 'invalid_state' | 'cancelled' | 'persistence_unknown', message: string) {
    super(message)
    this.name = 'HarnessError'
  }
}

/** 仅Data adapter已确认未提交/已回滚时使用；未知网络/驱动异常不得转换成此类型。 */
export class RunStoreRejected extends HarnessError {
  constructor(code: 'conflict' | 'not_found' | 'lease_lost') {
    super(code, code === 'conflict' ? '运行状态已发生冲突' : code === 'not_found' ? '运行不存在' : '运行租约已失效')
    this.name = 'RunStoreRejected'
  }
}

export class ToolResultCheckpointUnavailable extends Error {
  constructor(readonly observed: {
    readonly callId: string
    readonly successful: boolean
    readonly mutated: boolean
  }) { super('工具实际回执未能安全固化') }
}
