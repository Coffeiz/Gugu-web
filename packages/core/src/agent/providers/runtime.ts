import { formatToolResults } from './tool-result-format.js'
import { placeToolReminder } from '../context/assemble.js'
import { canonicalEventStats, stableJson } from '../context/history/canonical-history.js'
import { throwIfCancelled } from './errors.js'
import type { BranchProviderPort, CanonicalContextPorts, ContextReferenceCodec, ContextServices, ProviderPort, SummaryGenerationPorts } from '../ports.js'
import type { BranchInput, BranchName, CanonicalRunContext, FrozenProviderRequest, Json, ProviderEvent, ProviderRequest, RunIdentity } from '../models.js'
import { hasInitialInlineImage,restorePreparedContext } from '../context/history/attachment-refs.js'
import type { HistorySanitization, JsonObject, ProviderCompletion, ProviderConfig, ProviderConnectionTiming, ProviderDriverDependencies, ProviderInvocation, ProviderProjection, ProviderTransport, ProviderTransportFactory, ProviderWire } from './contracts.js'
import { providerSelection } from './registry.js'
import { ProviderError, classifyProviderError, providerFailureFields } from './errors.js'
import { clone, observe, record } from './values.js'
import { prepareAnthropicCache, InProcessPrefixCoordinator, stableRequestFingerprint, providerCacheSupported } from './cache.js'
import type { PrefixCoordinator } from './cache.js'
import { streamWithRetry } from './retry.js'
import type { RetryClock } from './retry.js'
import { ProviderClientPool, providerConfigKey } from './client-pool.js'
import { stripThinking, ProviderStreamSanitizer, sanitizeProviderText } from './sanitize.js'
import { normalizedApiKey } from './diagnostics.js'
import { RequestProbe, credentialFree, providerCacheDiagnostics } from './cache-probe.js'
import type { ProviderProbeSink } from './cache-probe.js'
import { anthropicRequestStructure, recordProviderBoundaryObservations } from './observation.js'
import { outputBudget, parseStructuredJson } from './standalone.js'
import { filterReasoningConfig } from './base.js'
import { stripCacheControl } from './openai/history.js'
import { recordAgentObservation } from '../observation.js'
import type { AgentObservationPort } from '../observation.js'

function providerToolSchemas(capabilities: CanonicalRunContext['capabilities']) {
  if (!capabilities) return []
  const names = capabilities.providerToolNames
  if (!names) return capabilities.tools.map(tool => clone(tool.schema))
  const definitions = new Map(capabilities.tools.map(tool => [tool.name, tool.schema]))
  return names.flatMap(name => {
    const schema = definitions.get(name)
    return schema ? [clone(schema)] : []
  })
}

export interface ProviderRuntimeOptions extends ContextServices {
  /** 通用观测端口只接收实际请求 body，不接收传输凭据或请求头。 */
  readonly observation?: AgentObservationPort
  /** 由Host的可信选模/BYOK解析器提供，必须与Harness冻结模型身份一致。 */
  resolve(identity: RunIdentity, modelIdentity: string, signal: AbortSignal): Promise<{ modelIdentity: string; accessScopeHash: string; config: ProviderConfig; systemPrompt: string }>
  readonly references: ContextReferenceCodec
  readonly prepareRequest: CanonicalContextPorts['prepareRequest']
  readonly transport?: ProviderTransport
  readonly createTransport?: (config: ProviderConfig) => ProviderTransport & { close(): Promise<void> }
  readonly transportFactory?: ProviderTransportFactory
  readonly networkIdentity?: string
  readonly diagnose?: (code: string, error: unknown) => void
  readonly clock?: RetryClock
  readonly coordinator?: PrefixCoordinator
  readonly probeSink?: ProviderProbeSink
  readonly continuationTtlMs?: number
  readonly maxContinuationEntries?: number
  readonly maxContinuationBytes?: number
  readonly maxContinuationTotalBytes?: number
  readonly continuationStore?: ProviderContinuationStore
  readonly invalidateContinuation?: (context: CanonicalRunContext, signal: AbortSignal) => Promise<void>
  readonly ensureContinuation?: (context: CanonicalRunContext, signal: AbortSignal) => Promise<void>
}
interface PrivateContinuation { identity: RunIdentity; modelIdentity: string; accessScopeHash: string; round: number; areaDigest: string; value: unknown; expiresAt: number; bytes: number }
type ContinuationScope = Pick<PrivateContinuation, 'identity' | 'modelIdentity' | 'accessScopeHash'>
export interface ProviderContinuationStore {
  save(scope: ContinuationScope, reference: string, value: Pick<PrivateContinuation, 'round' | 'areaDigest' | 'value'>, ttlMs: number): Promise<void>
  read(scope: ContinuationScope, reference: string): Promise<Pick<PrivateContinuation, 'round' | 'areaDigest' | 'value'> | null>
}

/** cache标记可能把字符串包成单个text块；这里只证明同构，复用时仍发送原始wire。 */
function comparableWire(value: Json): Json {
  const clean = stripCacheControl(value)
  if (Array.isArray(clean)) return clean.map(comparableWire)
  if (clean && typeof clean === 'object') {
    const result = Object.fromEntries(Object.entries(clean).map(([key, item]) => [key, comparableWire(item)]))
    const content = result.content
    if (Array.isArray(content) && content.length === 1) {
      const block = record(content[0])
      if (block.type === 'text' && typeof block.text === 'string' && Object.keys(block).every(key => ['type', 'text'].includes(key))) result.content = block.text
    }
    return result
  }
  return clean
}

/** 可实际装配到Harness的Provider运行时；仅存协议私有材料，不接管Run状态或数据事务。 */
export class ProviderRuntime implements ProviderPort<CanonicalRunContext> {
  readonly #titleTasks = new Set<Promise<void>>()
  readonly #requests = new Map<string, FrozenProviderRequest>()
  readonly #continuations = new Map<string, PrivateContinuation>()
  readonly #prefixes = new Map<string, Promise<Awaited<ReturnType<CanonicalContextPorts['prepareRequest']>>>>()
  readonly #pool: ProviderClientPool<ProviderTransport & { close(): Promise<void> }>
  readonly #coordinator: PrefixCoordinator
  #continuationBytes = 0
  readonly #diagnose = (code: string, error: unknown): void => { observe(() => this.options.diagnose?.(code, error)) }
  constructor(readonly options: ProviderRuntimeOptions) {
    if (!options.transport && !options.createTransport && !options.transportFactory) throw new ProviderError('unsupported')
    for (const limit of [options.continuationTtlMs, options.maxContinuationEntries, options.maxContinuationBytes, options.maxContinuationTotalBytes])
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) throw new ProviderError('input_rejected')
    this.#pool = new ProviderClientPool({ diagnose: error => this.#diagnose('provider_client_close', error) })
    this.#coordinator = options.coordinator ?? new InProcessPrefixCoordinator()
  }
  #key(identity: RunIdentity): string { return this.options.digest([identity.ownerId, identity.sessionId, identity.runId]) }
  #now(): number { return this.options.clock?.now() ?? Date.now() }
  #dropContinuation(reference: string): void {
    const stored = this.#continuations.get(reference)
    if (stored) { this.#continuationBytes -= stored.bytes; this.#continuations.delete(reference) }
  }
  #observeContinuation(identity: RunIdentity, phase: 'restore' | 'stage', round: number, startedAt: number,
    status: 'success' | 'error', attributes: Readonly<Record<string, string | number | boolean>> = {}): void {
    const endedAt = this.#now()
    recordAgentObservation(this.options.observation, {
      identity, kind: 'state', name: phase === 'restore' ? 'Provider continuation restore' : 'Provider continuation stage',
      at: endedAt, round, spanId: `${identity.runId}:continuation:${phase}:${round}`,
      parentSpanId: identity.runId, status, startedAt, endedAt, durationMs: Math.max(0, endedAt - startedAt),
      attributes: {
        phase,
        continuation_attempted: true,
        ...(phase === 'restore' ? { continuation_reused: status === 'success', continuation_unavailable: status !== 'success' } : {}),
        state_status: phase === 'restore' ? status === 'success' ? 'reused' : 'unavailable' : status === 'success' ? 'captured' : 'unavailable',
        sequence: round,
        ...attributes,
      },
    })
  }
  #pruneContinuations(): void { for (const [reference, stored] of this.#continuations) if (stored.expiresAt <= this.#now()) this.#dropContinuation(reference) }
  readonly prepareRequest: CanonicalContextPorts['prepareRequest'] = (identity, signal, context) => {
    const key = this.#key(identity)
    let pending = this.#prefixes.get(key)
    if (!pending) {
      pending = this.options.prepareRequest(identity, signal, context).then(value =>
        clone(placeToolReminder(value, context?.capabilities?.toolReminder, context?.prepared, this.options.digest)))
      this.#prefixes.set(key, pending)
      void pending.catch(() => this.#prefixes.delete(key))
    }
    return pending.then(clone)
  }
  readonly rememberPreparedRequest: NonNullable<CanonicalContextPorts['rememberPreparedRequest']> = (identity, request) => {
    this.#prefixes.set(this.#key(identity), Promise.resolve(clone(request)))
  }
  async #selection(identity: RunIdentity, modelIdentity: string, signal: AbortSignal) {
    throwIfCancelled(signal)
    let selected: Awaited<ReturnType<ProviderRuntimeOptions['resolve']>>
    try { selected = await this.options.resolve(identity, modelIdentity, signal) }
    catch (error) { this.#diagnose('provider_selection', error); throwIfCancelled(signal); throw classifyProviderError(error) }
    throwIfCancelled(signal)
    if (!selected.modelIdentity || selected.modelIdentity !== modelIdentity || !selected.accessScopeHash || typeof selected.systemPrompt !== 'string') throw new ProviderError('input_rejected')
    return { ...providerSelection({ ...selected.config, api_key: normalizedApiKey(selected.config.api_key) }), systemPrompt: selected.systemPrompt, accessScopeHash: selected.accessScopeHash }
  }
  #transport(identity: RunIdentity, config: ProviderConfig, policy: ProviderInvocation['policy'], scope = this.#key(identity)): ProviderTransport {
    if (this.options.transport) return this.options.transport
    const snapshot = this.options.transportFactory?.snapshot(config)
    const key = providerConfigKey(policy.protocol(config), { baseUrl: policy.baseUrl(config), apiKey: config.api_key ?? '', headers: policy.headers(config), timeout: config.timeout_ms, networkIdentity: snapshot?.networkIdentity ?? this.options.networkIdentity }, this.options.digest)
    return this.#pool.get(scope, key, () => snapshot ? snapshot.create() : this.options.createTransport!(config))
  }
  async #shortCall(identity: RunIdentity, config: ProviderConfig, policy: ProviderInvocation['policy'], operation: (dependencies: ProviderDriverDependencies) => Promise<ProviderCompletion>, dynamicRows = 0): Promise<ProviderCompletion> {
    const scope = `short:${this.options.nextId()}`
    const probe: { current?: RequestProbe } = {}
    try {
      const transport = this.#transport(identity, config, policy, scope)
      const result = await operation({ digest: this.options.digest, diagnose: this.#diagnose,
        onUsage: (raw, normalized) => probe.current?.usage(raw, normalized),
        transport: { request: async (request, signal) => {
          if (this.options.probeSink) {
            probe.current?.fail(new ProviderError('stream_incomplete'))
            const body = record(request.body), rows = body.messages ?? body.input
            probe.current = this.#probe(body as JsonObject, config, policy, Array.isArray(rows) ? Math.max(0, rows.length - dynamicRows) : undefined)
          }
          return transport.request(request, signal)
        } },
      })
      probe.current?.success(result.usage)
      return result
    } catch (raw) { const error = classifyProviderError(raw); probe.current?.fail(error); throw error }
    finally { this.#pool.finish(scope) }
  }
  #probe(body: JsonObject, config: ProviderConfig, policy: ProviderInvocation['policy'], stableRowCount?: number, historySanitization?: HistorySanitization): RequestProbe {
    return new RequestProbe(body, { id: this.options.nextId(), digest: this.options.digest, now: () => this.#now(), sink: this.options.probeSink!,
      secrets: config.api_key ? [config.api_key] : [], diagnose: error => this.#diagnose('provider_probe_sink', error), cacheSupported: policy.capabilities(config).cache_mode === 'active', stableRowCount, historySanitization })
  }
  async #readContinuation(context: CanonicalRunContext) {
    const reference = context.continuationRef
    if (!reference) return null
    const startedAt = this.#now()
    this.#pruneContinuations()
    const local = this.#continuations.get(reference)
    try {
      if (local && (this.#key(local.identity) !== this.#key(context.identity)
        || local.modelIdentity !== context.modelIdentity || local.accessScopeHash !== context.accessScopeHash))
        throw new ProviderError('input_rejected')
      const stored = local ?? await this.options.continuationStore?.read(context, reference)
      if (!stored) {
        this.#diagnose('provider_continuation_unavailable', { modelIdentity: context.modelIdentity })
        throw new ProviderError('input_rejected')
      }
      this.#observeContinuation(context.identity, 'restore', stored.round, startedAt, 'success', {
        source: local ? 'memory' : 'store', state_digest: stored.areaDigest,
      })
      return stored
    } catch (error) {
      this.#observeContinuation(context.identity, 'restore', context.pendingRound?.round ?? 0, startedAt, 'error', { reason: 'unavailable' })
      throw error
    }
  }
  readonly stageContinuation: CanonicalContextPorts['stageContinuation'] = async input => {
    const startedAt = this.#now()
    let encoded: string
    let bytes = 0
    let failureReason: 'invalid_state' | 'size_limit' | 'persistence_failed' = 'invalid_state'
    try {
      try { encoded = JSON.stringify(input.value) }
      catch { throw new ProviderError('protocol') }
      if (typeof encoded !== 'string') throw new ProviderError('protocol')
      bytes = new TextEncoder().encode(encoded).byteLength
      if (bytes > (this.options.maxContinuationBytes ?? 16 * 1024 * 1024) || bytes > (this.options.maxContinuationTotalBytes ?? 64 * 1024 * 1024)) {
        failureReason = 'size_limit'
        throw new ProviderError('input_rejected')
      }
      const reference = `provider:${this.options.nextId()}`
      if (!/^[A-Za-z0-9:._-]{1,256}$/.test(reference)) throw new ProviderError('protocol')
      const ttlMs = this.options.continuationTtlMs ?? 15 * 60_000
      const { round, areaDigest, value } = input
      failureReason = 'persistence_failed'
      await this.options.continuationStore?.save(input, reference, { round, areaDigest, value }, ttlMs)
      for (const [previous, stored] of this.#continuations) if (this.#key(stored.identity) === this.#key(input.identity)) this.#dropContinuation(previous)
      this.#pruneContinuations()
      while (this.#continuations.size >= (this.options.maxContinuationEntries ?? 256) || this.#continuationBytes + bytes > (this.options.maxContinuationTotalBytes ?? 64 * 1024 * 1024)) this.#dropContinuation(this.#continuations.keys().next().value!)
      this.#continuations.set(reference, { identity: clone(input.identity), modelIdentity: input.modelIdentity, accessScopeHash: input.accessScopeHash, round, areaDigest, value: clone(value), expiresAt: this.#now() + ttlMs, bytes })
      this.#continuationBytes += bytes
      this.#observeContinuation(input.identity, 'stage', round, startedAt, 'success', { state_size: bytes, state_digest: areaDigest })
      return reference
    } catch (error) {
      this.#observeContinuation(input.identity, 'stage', input.round, startedAt, 'error', {
        reason: failureReason,
      })
      throw error
    }
  }
  /** 只由可信持久化Host恢复原引用；不会分配新引用或修改Canonical。 */
  restoreContinuation(input: { reference:string; identity:RunIdentity; modelIdentity:string; accessScopeHash:string; round:number; areaDigest:string; value:unknown }): void {
    if (!/^[A-Za-z0-9:._-]{1,256}$/.test(input.reference) || !Number.isSafeInteger(input.round) || input.round < 0
      || !input.areaDigest || !input.modelIdentity || !input.accessScopeHash) throw new ProviderError('input_rejected')
    let encoded:string
    try { encoded=JSON.stringify(input.value) } catch { throw new ProviderError('protocol') }
    if(typeof encoded!=='string')throw new ProviderError('protocol')
    const bytes=new TextEncoder().encode(encoded).byteLength
    if(bytes>(this.options.maxContinuationBytes??16*1024*1024)||bytes>(this.options.maxContinuationTotalBytes??64*1024*1024))throw new ProviderError('input_rejected')
    this.#pruneContinuations()
    const prior=this.#continuations.get(input.reference)
    if(prior&&(this.#key(prior.identity)!==this.#key(input.identity)||prior.modelIdentity!==input.modelIdentity||prior.accessScopeHash!==input.accessScopeHash
      ||prior.round!==input.round||prior.areaDigest!==input.areaDigest||stableJson(prior.value)!==stableJson(input.value)))throw new ProviderError('input_rejected')
    if(prior)return
    for(const[ref,stored]of this.#continuations)if(this.#key(stored.identity)===this.#key(input.identity))this.#dropContinuation(ref)
    while(this.#continuations.size>=(this.options.maxContinuationEntries??256)||this.#continuationBytes+bytes>(this.options.maxContinuationTotalBytes??64*1024*1024))
      this.#dropContinuation(this.#continuations.keys().next().value!)
    this.#continuations.set(input.reference,{identity:clone(input.identity),modelIdentity:input.modelIdentity,accessScopeHash:input.accessScopeHash,
      round:input.round,areaDigest:input.areaDigest,value:clone(input.value),bytes,expiresAt:this.#now()+(this.options.continuationTtlMs??15*60_000)})
    this.#continuationBytes+=bytes
  }
  /** 仅供 Host 事务回调访问私有值；失败不消费暂存记录，不能把结果写入 checkpoint。 */
  async withStagedContinuation<T>(context: CanonicalRunContext, callback: (input: {
    value: unknown; round: number; areaDigest: string
  }) => Promise<T>): Promise<T> {
    const staged = await this.#readContinuation(context)
    if (!staged) throw new ProviderError('input_rejected')
    return callback({ value: clone(staged.value), round: staged.round, areaDigest: staged.areaDigest })
  }
  readonly currentRequest: CanonicalContextPorts['currentRequest'] = (identity, input) => {
    const stored = this.#requests.get(this.#key(identity))
    if (!stored || stored.sourceCheckpointDigest !== input.checkpointDigest || stored.projection.modelIdentity !== input.modelIdentity || stored.accessScopeHash !== input.accessScopeHash) return null
    return clone(stored)
  }
  async *stream(request: ProviderRequest<CanonicalRunContext>): AsyncGenerator<ProviderEvent> {
    try { yield* this.#stream(request) }
    catch (raw) {
      const error = request.signal.aborted ? new ProviderError('cancelled') : classifyProviderError(raw)
      throw new ProviderError(error.code, { ...error.options, stage: error.options.stage ?? 'prepare' })
    }
  }
  async *#stream(request: ProviderRequest<CanonicalRunContext>): AsyncGenerator<ProviderEvent> {
    const { context, identity, signal } = request
    const preparationStartedAt = this.#now()
    let preparationObserved = false
    let responseStatus: number | undefined
    let retryAttempt = 0
    if (this.#key(context.identity) !== this.#key(identity)) throw new ProviderError('input_rejected')
    const { config, policy, driver, systemPrompt: boundSystem, accessScopeHash } = await this.#selection(identity, context.modelIdentity, signal)
    if (accessScopeHash !== context.accessScopeHash) throw new ProviderError('input_rejected')
    const systemPrompt = context.providerSystemPrompt ?? boundSystem
    if (context.continuationRef) await this.options.ensureContinuation?.(context, signal)
    throwIfCancelled(signal)
    const prepared = await restorePreparedContext(context.prepared, identity, { digest: this.options.digest, nextId: this.options.nextId, prepareRequest: (target, currentSignal) => this.prepareRequest({ ...identity, ...target }, currentSignal, context) }, this.options.references, signal)
    const area = prepared.area, continuation = clone((await this.#readContinuation(context))?.value)
    const initialImages = request.round === 1 ? area.entries.filter(entry => Array.isArray(entry.message.content) && hasInitialInlineImage(entry.message.content)).map(entry => entry.entryId) : []
    const stableMessages = [...area.requestPrefix, ...area.messages]
    const projectionOptions = { continuation, digest: this.options.digest, preserveNativeThinking: true, dynamicTailSize: area.dynamicTail.length }
    const stableHistory = driver.project(formatToolResults(stableMessages), config, policy, { ...projectionOptions, dynamicTailSize: 0 })
    let historySanitization: HistorySanitization | undefined
    const history = driver.project(formatToolResults([...stableMessages, ...area.dynamicTail]), config, policy, { ...projectionOptions, onSanitization: value => { historySanitization = value } })
    const storedAnchor = record(context.sourceEffects?.sessionSnapshot.state.context?.provider_cache_anchor)
    const tools = providerToolSchemas(context.capabilities)
    const cacheScope = driver.protocol === 'anthropic' ? this.options.digest({ accessScopeHash, config, systemPrompt, tools }) : undefined
    const anchor: unknown = context.providerCacheAnchor?.anchor
      ?? (cacheScope && storedAnchor.scope_digest === cacheScope ? storedAnchor : undefined)
    let actualCacheAnchor: unknown
    const scope = { ...identity, round: request.round, modelIdentity: context.modelIdentity, accessScopeHash: context.accessScopeHash }
    const input: ProviderInvocation = { config, policy, history, system: systemPrompt, tools, signal, scope, purpose: 'chat', continuation, cacheAnchor: anchor, stableHistoryCount: stableHistory.length }
    const transport = this.#transport(identity, config, policy)
    const probe: { current: RequestProbe | null } = { current: null }
    let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextInput: null as number | null }
    let attemptTiming: (ProviderConnectionTiming & { firstStreamEventMs?: number; firstVisibleTokenMs?: number }) | undefined
    let attemptStarted = 0
    const finishTiming = (outcome: 'completed' | 'retry' | 'error' | 'cancelled') => {
      if (!attemptTiming) return
      const timing = attemptTiming
      attemptTiming = undefined
      const at = this.#now()
      recordAgentObservation(this.options.observation, {
        identity, kind: 'provider', name: 'timing', at, round: request.round,
        attributes: { ...timing, attempt: retryAttempt + 1, outcome, streamEndMs: performance.now() - attemptStarted },
      })
    }
    const dependencies: ProviderDriverDependencies = {
      digest: this.options.digest, diagnose: this.#diagnose,
      onStreamEvent: () => {
        if (attemptTiming) attemptTiming.firstStreamEventMs ??= performance.now() - attemptStarted
      },
      onUsage: (raw, normalized) => probe.current?.usage(raw, normalized),
      transport: {
        request: async (outbound, outgoingSignal) => {
          let body = record(outbound.body), outgoing = outbound
          if (driver.protocol === 'anthropic' && Array.isArray(body.messages)) {
            const stableCount = body.messages.length - Math.max(0, history.length - stableHistory.length)
            const cached = prepareAnthropicCache(body.messages as JsonObject[], policy, config, this.options.digest, stableCount, anchor, cacheScope, context.providerCacheAnchor === null)
            body = { ...body, messages: cached.messages }
            outgoing = { ...outbound, body: body as JsonObject }
            actualCacheAnchor = { modelIdentity: context.modelIdentity, anchor: cached.anchor }
          }
          const rows = body.messages ?? body.input
          let diagnosticStableRows: number | undefined
          if (Array.isArray(rows)) {
            const wireSystem = body.system ?? body.instructions
            const stableBody = record(driver.buildRequest({ ...input, history: stableHistory, stableHistoryCount: stableHistory.length }, dependencies, true).body)
            const stableRows = stableBody.messages ?? stableBody.input
            const stableSystem = stableBody.system ?? stableBody.instructions
            const same = (left: unknown, right: unknown) => this.options.digest(comparableWire((left ?? null) as Json)) === this.options.digest(comparableWire((right ?? null) as Json))
            const stableRowCount = Array.isArray(stableRows) && stableRows.length <= rows.length
              && same(rows.slice(0, stableRows.length), stableRows) && same(wireSystem, stableSystem) ? stableRows.length : null
            const prefix = driver.project(formatToolResults(area.requestPrefix), config, policy, { digest: this.options.digest, preserveNativeThinking: true })
            const prefixRows = driver.protocol === 'responses' ? prefix.filter(row => row.role !== 'system')
              : record(driver.buildRequest({ ...input, history: prefix, continuation: undefined, stableHistoryCount: prefix.length }, dependencies, true).body).messages
            const protectedPrefixRowCount = Array.isArray(prefixRows) && same(rows.slice(0, prefixRows.length), prefixRows) ? prefixRows.length : undefined
            diagnosticStableRows = stableRowCount ?? undefined
            const projection: ProviderProjection = { ...area.identity(context.modelIdentity), dynamicTailSize: area.dynamicTail.length, wire: { protocol: driver.protocol, provider: policy.name, identity: { ownerId: identity.ownerId, sessionId: identity.sessionId }, accessScopeHash, messages: clone(rows) as JsonObject[], ...(stableRowCount === null ? {} : { stableRowCount }), ...(protectedPrefixRowCount === undefined ? {} : { protectedPrefixRowCount }), ...(wireSystem === undefined ? {} : { system: clone(wireSystem) as Json }) } }
            this.#requests.delete(this.#key(identity))
            // 动态系统内容若已并入稳定wire且无法证明分界，不伪造可复用快照。
            if (stableRowCount !== null) this.#requests.set(this.#key(identity), {
              sourceCheckpointDigest: context.prepared.digest, accessScopeHash: context.accessScopeHash,
              area: area.snapshot(), requestPrefix: area.requestPrefix, dynamicTail: area.dynamicTail, projection,
              systemPrompt,
              tools: clone(Array.isArray(body.tools) ? body.tools : input.tools) as Json[],
            })
          }
          if (this.options.probeSink && Array.isArray(rows)) {
            probe.current?.fail(new ProviderError('stream_incomplete'))
            probe.current = this.#probe(body as JsonObject, config, policy, diagnosticStableRows, historySanitization)
          }
          if (!preparationObserved) {
            const preparedAt = this.#now()
            recordAgentObservation(this.options.observation, {
              identity, kind: 'context', name: 'Provider client and schemas prepared', at: preparedAt,
              startedAt: preparationStartedAt, endedAt: preparedAt, durationMs: Math.max(0, preparedAt - preparationStartedAt),
              round: request.round, spanId: `${identity.runId}:round:${request.round}:phase:provider-prepared`,
              parentSpanId: `${identity.runId}:round:${request.round}`, status: 'success',
              attributes: { provider: policy.name, protocol: driver.protocol, toolCount: input.tools.length },
            })
            preparationObserved = true
          }
          const observedAt = this.#now()
          const roundSpanId = `${identity.runId}:round:${request.round}`
          const toolDiagnostics = providerCacheDiagnostics(body as JsonObject, this.options.digest, {
            cacheSupported: policy.capabilities(config).cache_mode === 'active', stableRowCount: diagnosticStableRows,
          })
          const canonicalStats = canonicalEventStats(area.messages)
          recordProviderBoundaryObservations({
            observation: this.options.observation, identity, round: request.round, at: observedAt,
            roundSpanId, protocol: driver.protocol, body: body as JsonObject,
            capabilities: context.capabilities, tools: input.tools,
            area: { revision: area.revision, digest: area.digest(), entries: area.entries, dynamicTail: area.dynamicTail },
            historySanitization, digest: this.options.digest, toolDiagnostics, canonicalStats,
          })
          recordAgentObservation(this.options.observation, {
            identity, kind: 'provider', name: 'request', at: observedAt, round: request.round,
            spanId: `${identity.runId}:round:${request.round}:provider`, parentSpanId: roundSpanId,
            status: 'sent', input: clone(body),
            attributes: {
              protocol: driver.protocol, provider: policy.name, model: config.model,
              cache_diagnostics: toolDiagnostics,
              ...(driver.protocol === 'anthropic' && Array.isArray(rows)
                ? { request_structure: anthropicRequestStructure(rows, this.options.digest) } : {}),
              ...(actualCacheAnchor === undefined ? {} : { cache_anchor: clone(actualCacheAnchor) }),
              ...(historySanitization ? { history_sanitization: clone(historySanitization) } : {}),
            },
          })
          responseStatus = undefined
          try {
            const timing: NonNullable<typeof attemptTiming> = {}
            attemptTiming = timing
            attemptStarted = performance.now()
            const response = await transport.request({
              ...outgoing,
              allowLocal: outgoing.allowLocal === true && ['local', 'ollama'].includes((config.provider ?? '').trim().toLowerCase()),
              onTiming: value => Object.assign(timing, value),
            }, outgoingSignal)
            timing.responseHeadersMs ??= performance.now() - attemptStarted
            responseStatus = response.status
            return response
          }
          catch (error) { probe.current?.fail(classifyProviderError(error)); throw error }
        },
      },
    }
    const markers = policy.sanitizerMarkers(config), filter = new ProviderStreamSanitizer(markers)
    try {
      for await (const event of streamWithRetry(() => driver.stream(input, dependencies), signal, { clock: this.options.clock })) {
        if (event.type === 'token') {
          const text = filter.feed(event.text)
          if (text) {
            if (attemptTiming) attemptTiming.firstVisibleTokenMs ??= performance.now() - attemptStarted
            yield { ...event, text }
          }
        }
        else if (event.type === 'complete') {
          probe.current?.success(usage)
          const tail = filter.flush()
          if (tail && attemptTiming) attemptTiming.firstVisibleTokenMs ??= performance.now() - attemptStarted
          finishTiming('completed')
          if (tail) yield { type: 'token', text: tail }
          yield { ...event, text: sanitizeProviderText(event.text, markers), ...(actualCacheAnchor === undefined ? {} : { cacheAnchor: actualCacheAnchor }),
            ...(initialImages.length ? { consumedInitialMedia: { expectedRevision: area.revision, entryIds: initialImages } } : {}) }
        } else {
          if (event.type === 'usage') usage = event.usage
          if (event.type === 'retry') { finishTiming('retry'); retryAttempt = event.attempt; probe.current?.fail(new ProviderError('upstream')) }
          yield event
        }
      }
    } catch (raw) {
      finishTiming(signal.aborted ? 'cancelled' : 'error')
      const classified = signal.aborted ? new ProviderError('cancelled') : classifyProviderError(raw)
      const error = new ProviderError(classified.code, {
        status: responseStatus, ...classified.options, retryAttempt,
        providerProtocol: driver.protocol,
        ...(classified.code === 'protocol' && !classified.options.protocolDetail ? { protocolDetail: 'unclassified_protocol_error' as const } : {}),
        stage: classified.options.stage ?? (responseStatus === undefined ? 'prepare' : 'stream'),
      })
      probe.current?.fail(error)
      if (error.options.protocolIncompatible) {
        try { await this.options.invalidateContinuation?.(context,signal) }
        catch(raw) {
          this.#diagnose('provider_continuation_invalidation_failed',raw)
          yield{type:'error',error:new ProviderError(error.code,{...error.options,retryable:false,stage:'continuation'}),contextOverflow:false}
          return
        }
        for (const [ref, stored] of this.#continuations) if (this.#key(stored.identity) === this.#key(identity)) this.#dropContinuation(ref)
      }
      yield { type: 'error', error, contextOverflow: error.code === 'context_overflow' && !error.options.outputStarted }
    } finally { finishTiming('cancelled') }
  }
  async completeBranch(input: BranchInput<ProviderWire> & { modelIdentity: string; scenario?: BranchName; outputMode?: 'text' | 'json'; maxOutputTokens?: number | null; cacheSingleflight?: boolean; thinking?: string | null }, signal = new AbortController().signal) {
    return this.#completeModelTask(input, signal)
  }
  async #completeModelTask(input: BranchInput<ProviderWire> & { modelIdentity: string; scenario?: BranchName; outputMode?: 'text' | 'json'; maxOutputTokens?: number | null; cacheSingleflight?: boolean; thinking?: string | null }, signal = new AbortController().signal) {
    const identity = { ownerId: input.ownerId, sessionId: input.sessionId, runId: input.runId ?? 'branch' }
    const observationIdentity = input.observationIdentity ?? identity
    const selected = await this.#selection(identity, input.modelIdentity, signal)
    const { policy, driver, accessScopeHash } = selected
    const config = input.thinking === undefined ? selected.config : filterReasoningConfig({ ...selected.config, thinking: input.thinking }, policy)
    if (input.projection && (input.projection.modelIdentity !== input.modelIdentity || input.projection.wire.protocol !== driver.protocol || input.projection.wire.provider !== policy.name
      || input.projection.wire.identity?.ownerId !== input.ownerId || input.projection.wire.identity?.sessionId !== input.sessionId || input.projection.wire.accessScopeHash !== accessScopeHash)) throw new ProviderError('input_rejected')
    const count = input.projection ? input.projection.wire.stableRowCount ?? (input.projection.dynamicTailSize === 0 ? input.projection.wire.messages.length : -1) : 0
    if (input.projection && (!Number.isSafeInteger(count) || count < 0 || count > input.projection.wire.messages.length)) throw new ProviderError('input_rejected')
    const stable = input.projection ? clone(input.projection.wire.messages.slice(0, count)) : driver.project(formatToolResults(input.canonicalHistory ?? []), config, policy, { digest: this.options.digest })
    const delta = driver.project([{ role: 'user', content: input.delta }], config, policy, { digest: this.options.digest })
    const invocation: ProviderInvocation = { config, policy, history: [...stable, ...delta], system: input.stableSystem, wireSystem: input.projection?.wire.system, tools: input.tools as JsonObject[], signal,
      scope: { ...identity, round: 0, modelIdentity: input.modelIdentity, accessScopeHash: '' }, purpose: 'branch', hasHistory: stable.length > 0,
      outputMode: input.outputMode ?? 'json', maxOutputTokens: input.maxOutputTokens === undefined ? undefined : input.thinking === 'disabled' ? input.maxOutputTokens : outputBudget(config, policy, input.maxOutputTokens), stableHistoryCount: stable.length }
    const result = await this.#shortCall(identity, config, policy, async dependencies => {
      const outbound = driver.buildRequest(invocation, dependencies, false)
      let body = record(outbound.body) as JsonObject
      const rowsKey = Array.isArray(body.messages) ? 'messages' : 'input'
      const rows = Array.isArray(body[rowsKey]) ? body[rowsKey] as JsonObject[] : []
      const stableCount = Math.max(0, rows.length - delta.length)
      if (input.projection && !policy.singleHistoryCacheAnchor(config)) {
        // 原生快照已有主请求断点；重新计划会移动旧锚点并破坏前缀。只追加分支末尾断点。
        if (stableCount !== stable.length || this.options.digest(comparableWire(rows.slice(0, stableCount))) !== this.options.digest(comparableWire(stable))) throw new ProviderError('input_rejected')
        const frozen = clone(stable), last = frozen.at(-1)
        if (last && policy.capabilities(config).cache_mode === 'active' && ['openai', 'anthropic'].includes(driver.protocol)) {
          if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }]
          else if (Array.isArray(last.content) && last.content.length) {
            const block = last.content.at(-1)
            if (block && typeof block === 'object' && !Array.isArray(block)) last.content[last.content.length - 1] = { ...block, cache_control: { type: 'ephemeral' } }
          }
        }
        body = { ...body, [rowsKey]: [...frozen, ...rows.slice(stableCount)] }
      }
      else if (driver.protocol === 'anthropic') body = { ...body, messages: prepareAnthropicCache(rows, policy, config, this.options.digest, stableCount).messages }
      const fingerprint = input.cacheSingleflight && providerCacheSupported(policy, config)
        ? stableRequestFingerprint(body, rowsKey, stable.length ? stableCount : 0, this.options.digest) : null
      const operation = async () => {
        if (input.runId) recordAgentObservation(this.options.observation, {
          identity: observationIdentity,
          kind: 'provider', name: 'request', at: this.#now(), round: 0,
          spanId: `${observationIdentity.runId}:round:0:provider`, parentSpanId: `${observationIdentity.runId}:round:0`, status: 'sent',
          input: input.scenario === 'reflection' && input.observationIdentity
            ? credentialFree(body, config.api_key ? [config.api_key] : [])
            : input.observationIdentity ? {
            request_fields: Object.keys(body), history_field: rowsKey, message_count: rows.length,
            body_bytes: new TextEncoder().encode(JSON.stringify(body)).byteLength, body_digest: this.options.digest(body),
          } : clone(body),
          attributes: { protocol: driver.protocol, provider: policy.name, model: config.model, purpose: 'branch', branch_name: input.scenario ?? 'unknown',
            cache_diagnostics: providerCacheDiagnostics(body, this.options.digest, { cacheSupported: policy.capabilities(config).cache_mode === 'active', stableRowCount: stableCount }) },
        })
        let result: ProviderCompletion
        try {
          result = await driver.complete(invocation, { ...dependencies, transport: { request: (_request, outgoingSignal) => dependencies.transport.request({ ...outbound, body }, outgoingSignal) } })
        } catch (raw) {
          if (input.runId) {
            const error = signal.aborted ? new ProviderError('cancelled') : classifyProviderError(raw)
            recordAgentObservation(this.options.observation, {
              identity: observationIdentity,
              kind: 'provider', name: 'complete', at: this.#now(), round: 0,
              spanId: `${observationIdentity.runId}:round:0:provider`, parentSpanId: `${observationIdentity.runId}:round:0`,
              status: error.code === 'cancelled' ? 'cancelled' : 'error',
              attributes: { protocol: driver.protocol, provider: policy.name, model: config.model, purpose: 'branch', branch_name: input.scenario ?? 'unknown', error_code: error.code, ...providerFailureFields(error) },
            })
          }
          throw raw
        }
        if (input.runId) recordAgentObservation(this.options.observation, {
          identity: observationIdentity,
          kind: 'provider', name: 'usage', at: this.#now(), round: 0, usage: result.usage,
          attributes: { protocol: driver.protocol, provider: policy.name, model: config.model, purpose: 'branch', branch_name: input.scenario ?? 'unknown' },
        })
        if (input.runId) recordAgentObservation(this.options.observation, {
          identity: observationIdentity,
          kind: 'provider', name: 'complete', at: this.#now(), round: 0,
          spanId: `${observationIdentity.runId}:round:0:provider`, parentSpanId: `${observationIdentity.runId}:round:0`,
          status: 'success', output: input.observationIdentity
            ? { response_chars: result.text.length, response_digest: this.options.digest(result.text) }
            : result.text,
          attributes: { protocol: driver.protocol, provider: policy.name, model: config.model, purpose: 'branch', branch_name: input.scenario ?? 'unknown' },
        })
        return result
      }
      return fingerprint
        ? this.#coordinator.run(this.options.digest({ owner: identity.ownerId, provider: policy.name, protocol: driver.protocol, endpoint: outbound.url, credential: config.api_key ?? '', fingerprint }), signal, operation)
        : operation()
    }, delta.length)
    return { output: stripThinking(result.text).trim(), usage: { ...clone(result.usage), finish_reason: result.finishReason, incomplete_reason: result.incompleteReason ?? null } as Json }
  }
  /** 独立反思只向模型提交已授权的本批证据。 */
  reflectionProvider(modelIdentity: string): BranchProviderPort<ProviderWire> {
    return {
      isInputRejected: error => error instanceof ProviderError && error.code === 'input_rejected',
      complete: async (input, signal) => {
        if (input.projection || input.canonicalHistory?.length || input.tools.length || input.cacheSingleflight)
          throw new ProviderError('input_rejected')
        const result = await this.#completeModelTask({ ...input, modelIdentity, scenario: 'reflection' }, signal)
        return { ...result, output: input.outputMode === 'json' ? parseStructuredJson(result.output) : result.output }
      },
    }
  }
  branchProvider(modelIdentity: string): BranchProviderPort<ProviderWire> {
    return {
      isInputRejected: error => error instanceof ProviderError && error.code === 'input_rejected',
      complete: async (input, signal) => {
        const result = await this.completeBranch({ ...input, modelIdentity }, signal)
        return { ...result, output: input.outputMode === 'json' ? parseStructuredJson(result.output) : result.output }
      },
    }
  }
  async summaryProjection(identity: RunIdentity, modelIdentity: string, signal = new AbortController().signal): Promise<Pick<SummaryGenerationPorts<ProviderWire>, 'transformProjection'>> {
    const { policy, driver, accessScopeHash } = await this.#selection(identity, modelIdentity, signal)
    return { transformProjection: (projection, stage) => {
      const wire = projection.wire
      if (projection.modelIdentity !== modelIdentity || wire.protocol !== driver.protocol || wire.provider !== policy.name
        || wire.identity.ownerId !== identity.ownerId || wire.identity.sessionId !== identity.sessionId || wire.accessScopeHash !== accessScopeHash)
        throw new ProviderError('input_rejected')
      const stable = wire.stableRowCount ?? (projection.dynamicTailSize === 0 ? wire.messages.length : -1), prefix = wire.protectedPrefixRowCount
      if (!Number.isSafeInteger(stable) || stable < 0 || stable > wire.messages.length || prefix === undefined || !Number.isSafeInteger(prefix) || prefix < 0 || prefix > stable)
        throw new ProviderError('input_rejected')
      const transformed = driver.transformHistory(wire.messages.slice(0, stable), stage, prefix)
      return { projection: { ...clone(projection), dynamicTailSize: 0, wire: { ...clone(wire), messages: transformed.messages, stableRowCount: transformed.messages.length } }, changedMessages: transformed.changedMessages }
    } }
  }
  async completeText(identity: RunIdentity, modelIdentity: string, prompt: string, maxTokens: number | null = 800, signal = new AbortController().signal): Promise<string> {
    const { config, policy, driver } = await this.#selection(identity, modelIdentity, signal)
    const result = await this.#shortCall(identity, config, policy, dependencies => driver.complete({ config, policy, history: driver.project([{ role: 'user', content: prompt }], config, policy, { digest: this.options.digest }), system: '', tools: [], signal,
      scope: { ...identity, round: 0, modelIdentity, accessScopeHash: '' }, purpose: 'standalone', maxOutputTokens: outputBudget(config, policy, maxTokens) },
    dependencies))
    return stripThinking(result.text).trim()
  }
  readonly releaseContinuations: CanonicalContextPorts['releaseContinuations'] = async identity => {
    this.#requests.delete(this.#key(identity)); this.#prefixes.delete(this.#key(identity))
    // 等待交互也会释放本次流；续接保留到同Run下一轮，过期或close后明确拒绝复用。
    this.#pruneContinuations()
    this.#pool.finish(this.#key(identity))
  }
  finishRun(identity: RunIdentity): void {
    for (const [reference, stored] of this.#continuations) if (this.#key(stored.identity) === this.#key(identity)) this.#dropContinuation(reference)
    this.#requests.delete(this.#key(identity)); this.#prefixes.delete(this.#key(identity)); this.#pool.finish(this.#key(identity))
  }
  scheduleSessionTitle(input: Parameters<CanonicalContextPorts['finalization']['complete']>[0], write: NonNullable<CanonicalContextPorts['writeSessionTitle']>): void {
    if (!input.text.trim()) return
    const signal = AbortSignal.timeout(5_000)
    const task = Promise.resolve().then(() => write(input, prompt =>
      this.completeText(input.identity, input.modelIdentity, prompt, 40, signal)))
      .catch(error => { this.#diagnose('session_title_failed', error) })
      .finally(() => { this.#titleTasks.delete(task) })
    this.#titleTasks.add(task)
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.#titleTasks])
    this.#requests.clear(); this.#continuations.clear(); this.#continuationBytes = 0; this.#prefixes.clear()
    await this.#pool.close()
  }
}

/** 复用现有Canonical Context各业务端口，只替换已经真实实现的Provider接线。 */
export type ProviderFactoryContext = Omit<CanonicalContextPorts, 'currentRequest' | 'stageContinuation' | 'releaseContinuations'>
function connectedContext(context: ProviderFactoryContext, runtime: ProviderRuntime) {
  return { provider: runtime, context: { ...context, prepareRequest: runtime.prepareRequest, rememberPreparedRequest: runtime.rememberPreparedRequest, currentRequest: runtime.currentRequest, stageContinuation: runtime.stageContinuation, releaseContinuations: runtime.releaseContinuations,
    finalization: { async complete(input) {
      try { await context.finalization.complete(input) }
      finally {
        runtime.finishRun(input.identity)
        if (context.writeSessionTitle) runtime.scheduleSessionTitle(input, context.writeSessionTitle)
      }
    } },
  } satisfies CanonicalContextPorts }
}

/** 复用现有Canonical Context各业务端口，只替换已经真实实现的Provider接线。 */
export function connectProviderHarness(context: CanonicalContextPorts, options: Omit<ProviderRuntimeOptions, 'references' | 'prepareRequest' | keyof ContextServices>) {
  return connectedContext(context, new ProviderRuntime({ ...options, digest: context.digest, nextId: context.nextId, references: context.references, prepareRequest: context.prepareRequest }))
}

export interface ProviderContextFactoryInput {
  /** Provider与完整Context必须共用这些实际端口，不能在工厂中替换身份指纹或引用授权。 */
  services: Pick<CanonicalContextPorts, 'digest' | 'nextId' | 'references' | 'prepareRequest'>
  createContext(runtime: ProviderRuntime): ProviderFactoryContext | Promise<ProviderFactoryContext>
}

/** 先创建唯一Provider，再装配依赖它的压缩/反思资源；不要求调用方提供占位端口。 */
export async function connectProviderHarnessWithContextFactory(input: ProviderContextFactoryInput,
  options: Omit<ProviderRuntimeOptions, 'references' | 'prepareRequest' | keyof ContextServices>) {
  const services = input?.services && { digest: input.services.digest, nextId: input.services.nextId,
    references: input.services.references, prepareRequest: input.services.prepareRequest }
  if (!services || [services.digest, services.nextId, services.prepareRequest].some(method => typeof method !== 'function')
    || !services.references || typeof services.references.hydrate !== 'function' || typeof services.references.dehydrate !== 'function')
    throw new ProviderError('input_rejected')
  const runtime = new ProviderRuntime({ ...options, ...services })
  try {
    const context = await input.createContext(runtime)
    if (!context || (['digest', 'nextId', 'references', 'prepareRequest'] as const).some(key => context[key] !== services[key])
      || [context.load, context.diagnoseCompactionFailure].some(method => typeof method !== 'function')
      || typeof context.preparation?.buildRag !== 'function' || typeof context.compaction?.summarize !== 'function' || typeof context.finalization?.complete !== 'function')
      throw new ProviderError('input_rejected')
    return connectedContext(context, runtime)
  } catch {
    try { await runtime.close() } catch (error) { observe(() => options.diagnose?.('context_factory_close', error)) }
    throw new ProviderError('input_rejected')
  }
}
