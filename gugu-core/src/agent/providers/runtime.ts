import { throwIfCancelled } from './errors.js'
import type { BranchProviderPort, CanonicalContextPorts, ContextReferenceCodec, ContextServices, ProviderPort } from '../harness/ports.js'
import type { BranchInput, CanonicalHarnessContext, FrozenProviderRequest, Json, ProviderEvent, ProviderRequest, RunIdentity } from '../harness/contracts.js'
import { hasInitialInlineImage,restorePreparedContext } from '../harness/history/attachment-refs.js'
import type { JsonObject, ProviderCompletion, ProviderConfig, ProviderDriverDependencies, ProviderInvocation, ProviderProjection, ProviderTransport, ProviderWire } from './contracts.js'
import { providerSelection } from './registry.js'
import { ProviderError, classifyProviderError } from './errors.js'
import { clone, observe, record } from './values.js'
import { prepareAnthropicCache, InProcessPrefixCoordinator, stableRequestFingerprint, providerCacheSupported } from './cache.js'
import type { PrefixCoordinator } from './cache.js'
import { streamWithRetry } from './retry.js'
import type { RetryClock } from './retry.js'
import { ProviderClientPool, providerConfigKey } from './client-pool.js'
import { stripThinking, ProviderStreamSanitizer, sanitizeProviderText } from './sanitize.js'
import { normalizedApiKey } from './diagnostics.js'
import { RequestProbe } from './cache-probe.js'
import type { ProviderProbeSink } from './cache-probe.js'
import { outputBudget, parseStructuredJson } from './standalone.js'
import { filterReasoningConfig } from './base.js'

export interface ProviderRuntimeOptions extends ContextServices {
  /** 由Host的可信选模/BYOK解析器提供，必须与Harness冻结模型身份一致。 */
  resolve(identity: RunIdentity, modelIdentity: string, signal: AbortSignal): Promise<{ modelIdentity: string; accessScopeHash: string; config: ProviderConfig; systemPrompt: string }>
  readonly references: ContextReferenceCodec
  readonly prepareRequest: CanonicalContextPorts['prepareRequest']
  readonly transport?: ProviderTransport
  readonly createTransport?: (config: ProviderConfig) => ProviderTransport & { close(): Promise<void> }
  readonly networkIdentity?: string
  readonly diagnose?: (code: string, error: unknown) => void
  readonly clock?: RetryClock
  readonly coordinator?: PrefixCoordinator
  readonly probeSink?: ProviderProbeSink
  readonly continuationTtlMs?: number
  readonly maxContinuationEntries?: number
  readonly maxContinuationBytes?: number
  readonly maxContinuationTotalBytes?: number
}
interface PrivateContinuation { identity: RunIdentity; modelIdentity: string; accessScopeHash: string; value: unknown; expiresAt: number; bytes: number }

/** 可实际装配到Harness的Provider运行时；仅存协议私有材料，不接管Run状态或数据事务。 */
export class ProviderRuntime implements ProviderPort<CanonicalHarnessContext> {
  readonly #requests = new Map<string, FrozenProviderRequest>()
  readonly #continuations = new Map<string, PrivateContinuation>()
  readonly #prefixes = new Map<string, Promise<Awaited<ReturnType<CanonicalContextPorts['prepareRequest']>>>>()
  readonly #pool: ProviderClientPool<ProviderTransport & { close(): Promise<void> }>
  readonly #coordinator: PrefixCoordinator
  #continuationBytes = 0
  readonly #diagnose = (code: string, error: unknown): void => { observe(() => this.options.diagnose?.(code, error)) }
  constructor(readonly options: ProviderRuntimeOptions) {
    if (!options.transport && !options.createTransport) throw new ProviderError('unsupported')
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
  #pruneContinuations(): void { for (const [reference, stored] of this.#continuations) if (stored.expiresAt <= this.#now()) this.#dropContinuation(reference) }
  readonly prepareRequest: CanonicalContextPorts['prepareRequest'] = (identity, signal) => {
    const key = this.#key(identity)
    let pending = this.#prefixes.get(key)
    if (!pending) {
      pending = this.options.prepareRequest(identity, signal).then(clone)
      this.#prefixes.set(key, pending)
      void pending.catch(() => this.#prefixes.delete(key))
    }
    return pending.then(clone)
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
    const key = providerConfigKey(policy.protocol(config), { baseUrl: policy.baseUrl(config), apiKey: config.api_key ?? '', headers: policy.headers(config), timeout: config.timeout_ms, networkIdentity: this.options.networkIdentity }, this.options.digest)
    return this.#pool.get(scope, key, () => this.options.createTransport!(config))
  }
  async #shortCall(identity: RunIdentity, config: ProviderConfig, policy: ProviderInvocation['policy'], operation: (dependencies: ProviderDriverDependencies) => Promise<ProviderCompletion>): Promise<ProviderCompletion> {
    const scope = `short:${this.options.nextId()}`
    const probe: { current?: RequestProbe } = {}
    try {
      const transport = this.#transport(identity, config, policy, scope)
      const result = await operation({ digest: this.options.digest, diagnose: this.#diagnose,
        onUsage: (raw, normalized) => probe.current?.usage(raw, normalized),
        transport: { request: async (request, signal) => {
          if (this.options.probeSink) {
            probe.current?.fail(new ProviderError('stream_incomplete'))
            probe.current = this.#probe(record(request.body) as JsonObject, config)
          }
          return transport.request(request, signal)
        } },
      })
      probe.current?.success(result.usage)
      return result
    } catch (raw) { const error = classifyProviderError(raw); probe.current?.fail(error); throw error }
    finally { this.#pool.finish(scope) }
  }
  #probe(body: JsonObject, config: ProviderConfig): RequestProbe {
    return new RequestProbe(body, { id: this.options.nextId(), digest: this.options.digest, now: () => this.#now(), sink: this.options.probeSink!,
      secrets: config.api_key ? [config.api_key] : [], diagnose: error => this.#diagnose('provider_probe_sink', error) })
  }
  #continuation(context: CanonicalHarnessContext): unknown {
    if (!context.continuationRef) return undefined
    this.#pruneContinuations()
    const stored = this.#continuations.get(context.continuationRef)
    if (!stored) {
      this.#diagnose('provider_continuation_unavailable', { modelIdentity: context.modelIdentity })
      throw new ProviderError('input_rejected')
    }
    if (this.#key(stored.identity) !== this.#key(context.identity) || stored.modelIdentity !== context.modelIdentity || stored.accessScopeHash !== context.accessScopeHash)
      throw new ProviderError('input_rejected')
    return clone(stored.value)
  }
  readonly stageContinuation: CanonicalContextPorts['stageContinuation'] = async input => {
    let encoded: string
    try { encoded = JSON.stringify(input.value) }
    catch { throw new ProviderError('protocol') }
    if (typeof encoded !== 'string') throw new ProviderError('protocol')
    const bytes = new TextEncoder().encode(encoded).byteLength
    if (bytes > (this.options.maxContinuationBytes ?? 16 * 1024 * 1024) || bytes > (this.options.maxContinuationTotalBytes ?? 64 * 1024 * 1024)) throw new ProviderError('input_rejected')
    for (const [reference, stored] of this.#continuations) if (this.#key(stored.identity) === this.#key(input.identity)) this.#dropContinuation(reference)
    const reference = `provider:${this.options.nextId()}`
    if (!/^[A-Za-z0-9:._-]{1,256}$/.test(reference)) throw new ProviderError('protocol')
    this.#pruneContinuations()
    while (this.#continuations.size >= (this.options.maxContinuationEntries ?? 256) || this.#continuationBytes + bytes > (this.options.maxContinuationTotalBytes ?? 64 * 1024 * 1024)) this.#dropContinuation(this.#continuations.keys().next().value!)
    this.#continuations.set(reference, { identity: clone(input.identity), modelIdentity: input.modelIdentity, accessScopeHash: input.accessScopeHash, value: clone(input.value), expiresAt: this.#now() + (this.options.continuationTtlMs ?? 15 * 60_000), bytes })
    this.#continuationBytes += bytes
    return reference
  }
  readonly currentRequest: CanonicalContextPorts['currentRequest'] = (identity, input) => {
    const stored = this.#requests.get(this.#key(identity))
    if (!stored || stored.sourceCheckpointDigest !== input.checkpointDigest || stored.projection.modelIdentity !== input.modelIdentity || stored.accessScopeHash !== input.accessScopeHash) return null
    return clone(stored)
  }
  async *stream(request: ProviderRequest<CanonicalHarnessContext>): AsyncGenerator<ProviderEvent> {
    const { context, identity, signal } = request
    if (this.#key(context.identity) !== this.#key(identity)) throw new ProviderError('input_rejected')
    const { config, policy, driver, systemPrompt, accessScopeHash } = await this.#selection(identity, context.modelIdentity, signal)
    if (accessScopeHash !== context.accessScopeHash) throw new ProviderError('input_rejected')
    const prepared = await restorePreparedContext(context.prepared, identity, { digest: this.options.digest, nextId: this.options.nextId, prepareRequest: this.prepareRequest }, this.options.references, signal)
    const area = prepared.area, continuation = this.#continuation(context)
    const initialImages = request.round === 1 ? area.entries.filter(entry => Array.isArray(entry.message.content) && hasInitialInlineImage(entry.message.content)).map(entry => entry.entryId) : []
    const stableMessages = [...area.requestPrefix, ...area.messages]
    const projectionOptions = { continuation, digest: this.options.digest, preserveNativeThinking: true, dynamicTailSize: area.dynamicTail.length }
    const stableHistory = driver.project(stableMessages, config, policy, { ...projectionOptions, dynamicTailSize: 0 })
    const history = driver.project([...stableMessages, ...area.dynamicTail], config, policy, projectionOptions)
    const anchor: unknown = context.providerCacheAnchor?.anchor
    let actualCacheAnchor: unknown
    const scope = { ...identity, round: request.round, modelIdentity: context.modelIdentity, accessScopeHash: context.accessScopeHash }
    const input: ProviderInvocation = { config, policy, history, system: systemPrompt, tools: context.capabilities?.tools.map(tool => clone(tool.schema)) ?? [], signal, scope, purpose: 'chat', continuation, cacheAnchor: anchor, stableHistoryCount: stableHistory.length }
    const transport = this.#transport(identity, config, policy)
    const probe: { current: RequestProbe | null } = { current: null }
    let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextInput: null as number | null }
    const dependencies: ProviderDriverDependencies = {
      digest: this.options.digest, diagnose: this.#diagnose,
      onUsage: (raw, normalized) => probe.current?.usage(raw, normalized),
      transport: {
        request: async (outbound, outgoingSignal) => {
          let body = record(outbound.body), outgoing = outbound
          if (driver.protocol === 'anthropic' && Array.isArray(body.messages)) {
            const stableCount = body.messages.length - Math.max(0, history.length - stableHistory.length)
            const cached = prepareAnthropicCache(body.messages as JsonObject[], policy, config, this.options.digest, stableCount, anchor)
            body = { ...body, messages: cached.messages }
            outgoing = { ...outbound, body: body as JsonObject }
            actualCacheAnchor = { modelIdentity: context.modelIdentity, anchor: cached.anchor }
          }
          const rows = body.messages ?? body.input
          if (this.options.probeSink && Array.isArray(rows)) {
            probe.current?.fail(new ProviderError('stream_incomplete'))
            probe.current = this.#probe(body as JsonObject, config)
          }
          if (Array.isArray(rows)) {
            const wireSystem = body.system ?? body.instructions
            const projection: ProviderProjection = { ...area.identity(context.modelIdentity), dynamicTailSize: area.dynamicTail.length, wire: { protocol: driver.protocol, provider: policy.name, identity: { ownerId: identity.ownerId, sessionId: identity.sessionId }, accessScopeHash, messages: clone(rows) as JsonObject[], ...(wireSystem === undefined ? {} : { system: clone(wireSystem) as Json }) } }
            this.#requests.set(this.#key(identity), {
              sourceCheckpointDigest: context.prepared.digest, accessScopeHash: context.accessScopeHash,
              area: area.snapshot(), requestPrefix: area.requestPrefix, dynamicTail: area.dynamicTail, projection,
              systemPrompt,
              tools: clone(Array.isArray(body.tools) ? body.tools : input.tools) as Json[],
            })
          }
          try { return await transport.request({ ...outgoing, allowLocal: outgoing.allowLocal === true && ['local', 'ollama'].includes((config.provider ?? '').trim().toLowerCase()) }, outgoingSignal) }
          catch (error) { probe.current?.fail(classifyProviderError(error)); throw error }
        },
      },
    }
    const markers = policy.sanitizerMarkers(config), filter = new ProviderStreamSanitizer(markers)
    try {
      for await (const event of streamWithRetry(() => driver.stream(input, dependencies), signal, { clock: this.options.clock })) {
        if (event.type === 'token') { const text = filter.feed(event.text); if (text) yield { ...event, text } }
        else if (event.type === 'complete') {
          probe.current?.success(usage)
          const tail = filter.flush(); if (tail) yield { type: 'token', text: tail }
          yield { ...event, text: sanitizeProviderText(event.text, markers), ...(actualCacheAnchor === undefined ? {} : { cacheAnchor: actualCacheAnchor }),
            ...(initialImages.length ? { consumedInitialMedia: { expectedRevision: area.revision, entryIds: initialImages } } : {}) }
        } else {
          if (event.type === 'usage') usage = event.usage
          if (event.type === 'retry') probe.current?.fail(new ProviderError('upstream'))
          yield event
        }
      }
    } catch (raw) {
      const error = signal.aborted ? new ProviderError('cancelled') : classifyProviderError(raw)
      probe.current?.fail(error)
      if (error.options.protocolIncompatible) for (const [ref, stored] of this.#continuations) if (this.#key(stored.identity) === this.#key(identity)) this.#dropContinuation(ref)
      yield { type: 'error', error, contextOverflow: error.code === 'context_overflow' && !error.options.outputStarted }
    }
  }
  async completeBranch(input: BranchInput<ProviderWire> & { modelIdentity: string; outputMode?: 'text' | 'json'; maxOutputTokens?: number | null; cacheSingleflight?: boolean; thinking?: string | null }, signal = new AbortController().signal) {
    const identity = { ownerId: input.ownerId, sessionId: input.sessionId, runId: input.runId ?? 'branch' }
    const selected = await this.#selection(identity, input.modelIdentity, signal)
    const { policy, driver, accessScopeHash } = selected
    const config = input.thinking === undefined ? selected.config : filterReasoningConfig({ ...selected.config, thinking: input.thinking }, policy)
    if (input.projection && (input.projection.modelIdentity !== input.modelIdentity || input.projection.wire.protocol !== driver.protocol || input.projection.wire.provider !== policy.name
      || input.projection.wire.identity?.ownerId !== input.ownerId || input.projection.wire.identity?.sessionId !== input.sessionId || input.projection.wire.accessScopeHash !== accessScopeHash)) throw new ProviderError('input_rejected')
    const stable = input.projection ? clone(input.projection.wire.messages) : driver.project(input.canonicalHistory ?? [], config, policy, { digest: this.options.digest })
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
      if (driver.protocol === 'anthropic') body = { ...body, messages: prepareAnthropicCache(rows, policy, config, this.options.digest, stableCount).messages }
      const fingerprint = input.cacheSingleflight && providerCacheSupported(policy, config)
        ? stableRequestFingerprint(body, rowsKey, stable.length ? stableCount : 0, this.options.digest) : null
      const operation = () => driver.complete(invocation, { ...dependencies, transport: { request: (_request, outgoingSignal) => dependencies.transport.request({ ...outbound, body }, outgoingSignal) } })
      return fingerprint
        ? this.#coordinator.run(this.options.digest({ owner: identity.ownerId, provider: policy.name, protocol: driver.protocol, endpoint: outbound.url, credential: config.api_key ?? '', fingerprint }), signal, operation)
        : operation()
    })
    return { output: stripThinking(result.text).trim(), usage: clone(result.usage) as unknown as Json }
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
  async close(): Promise<void> { this.#requests.clear(); this.#continuations.clear(); this.#continuationBytes = 0; this.#prefixes.clear(); await this.#pool.close() }
}

/** 复用现有Canonical Context各业务端口，只替换已经真实实现的Provider接线。 */
export function connectProviderHarness(context: CanonicalContextPorts, options: Omit<ProviderRuntimeOptions, 'references' | 'prepareRequest' | keyof ContextServices>) {
  const runtime = new ProviderRuntime({ ...options, digest: context.digest, nextId: context.nextId, references: context.references, prepareRequest: context.prepareRequest })
  return { provider: runtime, context: { ...context, prepareRequest: runtime.prepareRequest, currentRequest: runtime.currentRequest, stageContinuation: runtime.stageContinuation, releaseContinuations: runtime.releaseContinuations,
    finalization: { async complete(input) { await context.finalization.complete(input); runtime.finishRun(input.identity) } },
  } satisfies CanonicalContextPorts }
}
