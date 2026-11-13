import type { CanonicalMessage, Json, OpaqueProviderProjection, ProviderEvent, RunIdentity, Usage } from '../harness/contracts.js'
export type { Json } from '../harness/contracts.js'

export type JsonObject = { [key: string]: Json }
export type ProviderProtocol = 'openai' | 'responses' | 'anthropic' | 'ollama'
export type RequestPurpose = 'chat' | 'branch' | 'standalone'

/** 已通过可信配置解析的模型；保留既有配置字段名，不读取全局配置或凭据存储。 */
export interface ProviderConfig {
  readonly provider?: string
  readonly model: string
  readonly api_format?: string
  readonly base_url?: string
  readonly api_key?: string
  readonly thinking?: string | null
  readonly reasoning_effort?: string
  readonly max_tokens?: number
  readonly temperature?: number
  readonly top_p?: number
  readonly image?: boolean
  readonly audio?: boolean
  readonly video?: boolean
  readonly capability_overrides?: Readonly<Record<string, boolean>>
  readonly ollama_api_mode?: string
  readonly timeout_ms?: number
  readonly [key: string]: unknown
}

export interface ProviderCapabilities {
  readonly api_format: ProviderProtocol
  readonly cache_mode: 'none' | 'active' | 'passive'
  readonly thinking: boolean
  readonly structured_json: boolean
  readonly structured_schema: boolean
  readonly tools: boolean
  readonly parallel_tools: boolean
  readonly image: boolean
  readonly audio: boolean
  readonly video: boolean
}
export interface ReasoningCapabilities {
  readonly modes: readonly string[]
  readonly efforts: readonly string[]
  readonly effort_map?: Readonly<Record<string, string>>
  readonly supports_adaptive_thinking: boolean
}
export interface ResponsesInputCapabilities {
  readonly image: boolean
  readonly audio_formats: readonly string[]
  readonly video: boolean
}
export interface MediaLimits {
  readonly [key: string]: number | string | readonly string[] | boolean | null | undefined
}

/** 厂商策略只声明协议能力及请求参数，不拥有 Run、工具执行或凭据来源。 */
export interface ProviderPolicy {
  readonly name: string
  capabilities(config: ProviderConfig): ProviderCapabilities
  supportedApiFormats(config: ProviderConfig): readonly ProviderProtocol[]
  protocol(config: ProviderConfig): ProviderProtocol
  baseUrl(config: ProviderConfig): string
  headers(config: ProviderConfig): Readonly<Record<string, string>>
  reasoningCapabilities(config: ProviderConfig, protocol: ProviderProtocol): ReasoningCapabilities
  parameters(config: ProviderConfig, protocol: ProviderProtocol, purpose: RequestPurpose): JsonObject
  structuredOutput(config: ProviderConfig, schema?: JsonObject): JsonObject
  responsesInputCapabilities(config: ProviderConfig): ResponsesInputCapabilities
  responsesStore(config: ProviderConfig): boolean | undefined
  responsesPromptCacheKey(config: ProviderConfig): boolean
  explicitCache(config: ProviderConfig): boolean
  singleHistoryCacheAnchor(config: ProviderConfig): boolean
  sanitizerMarkers(config: ProviderConfig): readonly string[]
  mediaLimits(config: ProviderConfig): MediaLimits
}

export interface ProviderScope extends RunIdentity {
  readonly round: number
  readonly modelIdentity: string
  readonly accessScopeHash: string
}

/** 仅在受限内存中存在的协议请求；不得进入 checkpoint、公开日志或事件。 */
export interface ProviderInvocation {
  readonly config: ProviderConfig
  readonly policy: ProviderPolicy
  readonly history: readonly JsonObject[]
  readonly system: string
  readonly wireSystem?: Json
  readonly tools: readonly JsonObject[]
  readonly signal: AbortSignal
  readonly scope: ProviderScope
  readonly purpose: RequestPurpose
  readonly maxOutputTokens?: number | null
  readonly outputMode?: 'text' | 'json'
  readonly hasHistory?: boolean
  readonly continuation?: unknown
  readonly cacheAnchor?: unknown
  readonly promptCacheKey?: string
  readonly stableHistoryCount?: number
}
export interface ProviderCompletion {
  readonly text: string
  readonly usage: Usage
  readonly finishReason: string | null
  readonly incompleteReason?: string | null
  readonly continuation?: unknown
}

export interface ProviderHttpRequest {
  readonly url: string
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly headers: Readonly<Record<string, string>>
  readonly body?: JsonObject | Uint8Array | AsyncIterable<Uint8Array>
  readonly timeoutMs?: number
  /** 只允许显式 local/ollama 的受信配置；普通 BYOK 不因此获得内网权限。 */
  readonly allowLocal?: boolean
}
export interface ProviderHttpResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: AsyncIterable<Uint8Array>
  /** 不继续消费流时必须取消底层连接。 */
  cancel(reason?: unknown): Promise<void> | void
}
export interface ProviderTransport {
  /** 实现必须验证并固定 DNS 目标，禁自动跟随重定向，响应取消与读超时。 */
  request(request: ProviderHttpRequest, signal: AbortSignal): Promise<ProviderHttpResponse>
  close?(): Promise<void>
}
export interface ProviderDriverDependencies {
  readonly transport: ProviderTransport
  /** 原始错误仅可进入受限诊断；驱动不能将其拷贝到事件。 */
  readonly diagnose?: (code: string, error: unknown) => void
  readonly digest: (value: unknown) => string
  /** HTTP JSON原始usage只交受控Provider探针，不作为SDK对象传入Harness事件。 */
  readonly onUsage?: (rawUsage: unknown, normalizedUsage: Usage) => void
}
export interface ProjectionOptions {
  readonly digest?: (value: unknown) => string
  readonly preserveNativeThinking?: boolean
  readonly continuation?: unknown
  readonly dynamicTailSize?: number
}
export interface ProtocolDriver {
  readonly protocol: ProviderProtocol
  /** 与实际发送共用的纯请求构建，用于最终wire指纹和能力协调。 */
  buildRequest(input: ProviderInvocation, dependencies: ProviderDriverDependencies, streaming: boolean): ProviderHttpRequest
  project(messages: readonly CanonicalMessage[], config: ProviderConfig, policy: ProviderPolicy, options?: ProjectionOptions): JsonObject[]
  stream(input: ProviderInvocation, dependencies: ProviderDriverDependencies): AsyncIterable<ProviderEvent>
  complete(input: ProviderInvocation, dependencies: ProviderDriverDependencies): Promise<ProviderCompletion>
}

export interface ProviderWire {
  readonly protocol: ProviderProtocol
  readonly provider: string
  readonly messages: readonly JsonObject[]
  readonly system?: Json
  readonly identity: Pick<RunIdentity, 'ownerId' | 'sessionId'>
  readonly accessScopeHash: string
}
export type ProviderProjection = OpaqueProviderProjection<ProviderWire>
