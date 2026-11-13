import { observe } from '../values.js'
import type { ProviderEvent, ToolCall, Usage } from '../../harness/contracts.js'
import { configuredResponsesInput, createPolicy, DEFAULT_CAPABILITIES, DEFAULT_REASONING, normalizeBaseUrl } from '../base.js'
import type { JsonObject, ProtocolDriver, ProviderConfig, ProviderDriverDependencies, ProviderHttpRequest, ProviderInvocation, ReasoningCapabilities } from '../contracts.js'
import { classifyProviderError, ProviderError } from '../errors.js'
import { endpoint, requestEvents, requestJson } from '../http.js'
import { mergeOpenaiSystemMessages, prepareOpenAiCache, projectOpenai, sanitizeOpenaiToolHistory, transformOpenaiWireHistory } from './history.js'
import { array, clone, finite, record, reportUsage, text } from '../values.js'

function official(config: ProviderConfig): boolean {
  if ((config.provider ?? '').toLowerCase() !== 'openai') return false
  try { return new URL(config.base_url || 'https://api.openai.com/v1').hostname === 'api.openai.com' } catch { return false }
}
export function openaiReasoningCapabilities(config: ProviderConfig, protocol: string): ReasoningCapabilities {
  if (!official(config) || !['openai', 'responses'].includes(protocol)) return DEFAULT_REASONING
  const model = config.model.trim().toLowerCase()
  const efforts = model.startsWith('gpt-5-pro') ? ['high']
    : model.startsWith('gpt-5.6') ? ['none', 'low', 'medium', 'high', 'xhigh', 'max']
      : model.startsWith('gpt-6-astra') ? ['low', 'medium', 'high', 'xhigh', 'max']
        : model.startsWith('gpt-6-sol') || model.startsWith('gpt-6-luna') ? ['none', 'low', 'medium', 'high', 'xhigh', 'max']
          : model.startsWith('gpt-5.5') ? ['low', 'medium', 'high', 'xhigh']
            : ['gpt-5', 'gpt-5-mini', 'gpt-5-nano'].includes(model) ? ['minimal', 'low', 'medium', 'high'] : []
  return { ...DEFAULT_REASONING, efforts }
}
export const openaiPolicy = createPolicy('unknown', {
  capabilities: () => ({ ...DEFAULT_CAPABILITIES, api_format: 'openai', cache_mode: 'active' }),
  supportedApiFormats: config => config.provider?.toLowerCase() === 'openai' ? ['openai', 'responses'] : ['openai'],
  baseUrl: config => normalizeBaseUrl(config.base_url || 'https://api.openai.com/v1'),
  reasoningCapabilities: openaiReasoningCapabilities,
  responsesInputCapabilities: config => configuredResponsesInput(config, ['mp3', 'wav']),
  responsesPromptCacheKey: official,
  responsesStore: config => official(config) ? false : undefined,
})

export const unknownUsage: Usage = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextInput: null })

/** 缓存 token 已在 prompt 总量中，不能再加一次；缺报保持 contextInput=null。 */
export function normalizeOpenaiUsage(value: unknown): Usage {
  const usage = record(value)
  const total = finite(usage.input_tokens) ?? finite(usage.prompt_tokens)
  const cacheRead = finite(usage.prompt_cache_hit_tokens) || finite(record(usage.input_tokens_details).cached_tokens) || finite(record(usage.prompt_tokens_details).cached_tokens) || finite(usage.cached_tokens) || 0
  const cacheWrite = finite(usage.cache_creation_input_tokens) || finite(usage.prompt_cache_creation_tokens) || finite(usage.cache_write_tokens) || 0
  return { input: total === null ? 0 : Math.max(0, total - cacheRead - cacheWrite), output: finite(usage.output_tokens) ?? finite(usage.completion_tokens) ?? 0, cacheRead, cacheWrite, contextInput: total }
}

export function normalizedToolCall(id: string, name: string, raw: string, responsesItemId?: string): ToolCall {
  let input: unknown
  let parseError: 'invalid_json' | 'not_object' | undefined
  try { input = JSON.parse(raw || '{}'); if (!input || typeof input !== 'object' || Array.isArray(input)) parseError = 'not_object' }
  catch { input = {}; parseError = 'invalid_json' }
  return { id, name, input: parseError ? {} : input, ...(parseError ? { parseError } : { rawArguments: raw || '{}' }), ...(responsesItemId ? { responsesItemId } : {}) }
}

export function openaiHttpRequest(input: ProviderInvocation, body: JsonObject, path: string): ProviderHttpRequest {
  return { url: endpoint(input.policy.baseUrl(input.config), path), method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${input.config.api_key || (input.policy.name === 'ollama' ? 'ollama' : 'dummy')}`, ...input.policy.headers(input.config) }, body, timeoutMs: input.config.timeout_ms, allowLocal: ['local', 'ollama'].includes((input.config.provider ?? '').trim().toLowerCase()) }
}

function requestBody(input: ProviderInvocation, deps: ProviderDriverDependencies, streaming: boolean) {
  const stableSize = input.stableHistoryCount ?? input.history.length
  const stable = sanitizeOpenaiToolHistory(input.history.slice(0, stableSize))
  const dynamic = sanitizeOpenaiToolHistory(input.history.slice(stableSize))
  const history = mergeOpenaiSystemMessages([...stable, ...dynamic], input.system)
  // 独立分支会在没有历史时仍新增基础system；它属于固定前缀，不是动态任务。
  const stableCount = mergeOpenaiSystemMessages(stable, input.system).length
  const capabilities = input.policy.capabilities(input.config)
  const enabled = (kind: 'image' | 'audio' | 'video') => (input.config.capability_overrides?.[kind] ?? input.config[kind] ?? capabilities[kind]) === true
  for (const row of history) for (const part of array(row.content).map(record)) {
    if ((part.type === 'image_url' && !enabled('image')) || (part.type === 'input_audio' && !enabled('audio')) || (part.type === 'video_url' && !enabled('video')))
      throw new ProviderError('unsupported')
    if (part.type === 'input_image' || part.type === 'input_video') throw new ProviderError('unsupported')
  }
  const { messages, anchor } = prepareOpenAiCache(history, input.policy, input.config, deps.digest, stableCount, input.cacheAnchor)
  for (const row of messages) for (const raw of array(row.tool_calls)) delete record(raw).responses_item_id
  const body: JsonObject = { model: input.config.model, messages, ...input.policy.parameters(input.config, 'openai', input.purpose) }
  const max = input.maxOutputTokens === undefined ? input.config.max_tokens : input.maxOutputTokens
  if (max !== undefined && max !== null) body.max_tokens = max
  if (input.config.temperature !== undefined) body.temperature = input.config.temperature
  if (input.config.top_p !== undefined) body.top_p = input.config.top_p
  if (input.tools.length) { body.tools = clone([...input.tools]); body.tool_choice = 'auto' }
  if (input.outputMode === 'json' && !input.hasHistory) Object.assign(body, input.policy.structuredOutput(input.config))
  if (streaming) { body.stream = true; body.stream_options = { include_usage: true } }
  return { body, anchor }
}

function extractContinuation(input: ProviderInvocation, reasoning: string, calls: readonly ToolCall[]) {
  if (!reasoning) return undefined
  const previous = record(record(input.continuation).reasoningByCall)
  return { kind: 'openai', reasoningByCall: { ...previous, ...Object.fromEntries(calls.map(call => [call.id, reasoning])) } }
}

async function* stream(input: ProviderInvocation, deps: ProviderDriverDependencies): AsyncGenerator<ProviderEvent> {
  const { body, anchor } = requestBody(input, deps, true)
  const calls = new Map<number, { id: string; name: string; raw: string }>()
  let output = '', reasoning = '', usage = unknownUsage, finishReason: string | null = null, seen = false, hasUsage = false
  try { for await (const event of requestEvents(deps, openaiHttpRequest(input, body, 'chat/completions'), input.signal)) {
    if (event.event === 'done') break
    const chunk = record(event.data)
    if (chunk.error) { observe(() => deps.diagnose?.('openai.stream_error', chunk.error)); throw new ProviderError('upstream', { requestStarted: true, outputStarted: output.length > 0 || calls.size > 0 }) }
    if (chunk.usage != null) { usage = normalizeOpenaiUsage(chunk.usage); hasUsage = true; reportUsage(deps, chunk.usage, usage); yield { type: 'usage', usage } }
    const choice = record(array(chunk.choices)[0])
    if (!Object.keys(choice).length) continue
    seen = true
    if (text(choice.finish_reason)) finishReason = text(choice.finish_reason)
    const delta = record(choice.delta)
    reasoning += text(delta.reasoning_content)
    const token = text(delta.content)
    if (token) { output += token; yield { type: 'token', text: token } }
    for (const raw of array(delta.tool_calls)) {
      const part = record(raw), index = finite(part.index)
      if (index === null || !Number.isSafeInteger(index)) throw new ProviderError('protocol', { requestStarted: true, outputStarted: true })
      const current = calls.get(index) ?? { id: '', name: '', raw: '' }, fn = record(part.function)
      if (fn.arguments !== undefined && fn.arguments !== null && typeof fn.arguments !== 'string') throw new ProviderError('protocol', { requestStarted: true, outputStarted: true })
      if (text(part.id)) current.id = text(part.id)
      if (text(fn.name)) current.name = text(fn.name)
      current.raw += text(fn.arguments); calls.set(index, current)
    }
  } } catch (error) {
    const classified = error instanceof ProviderError ? error : classifyProviderError(error)
    throw new ProviderError(classified.code, { ...classified.options, outputStarted: classified.options.outputStarted || !!output || !!reasoning || calls.size > 0 })
  }
  if (!seen || !finishReason) throw new ProviderError('stream_incomplete', { requestStarted: true, outputStarted: !!output || calls.size > 0 })
  const normalized = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => {
    if (!call.id || !call.name) throw new ProviderError('protocol', { requestStarted: true, outputStarted: true })
    return normalizedToolCall(call.id, call.name, call.raw)
  })
  if (!hasUsage) reportUsage(deps, null, unknownUsage)
  yield { type: 'complete', text: output, calls: normalized, requiresTools: normalized.length > 0, finishReason, ...(finishReason === 'length' ? { incompleteReason: 'max_tokens' } : {}), ...(extractContinuation(input, reasoning, normalized) ? { continuation: extractContinuation(input, reasoning, normalized) } : {}), ...(anchor ? { cacheAnchor: { modelIdentity: input.scope.modelIdentity, anchor } } : {}) }
}

export const openaiDriver: ProtocolDriver = {
  protocol: 'openai',
  transformHistory: (history, stage, protectedPrefixRows) => transformOpenaiWireHistory(history, stage, protectedPrefixRows),
  buildRequest: (input, deps, streaming) => openaiHttpRequest(input, requestBody(input, deps, streaming).body, 'chat/completions'),
  project: (messages, config, policy, options) => {
    const result = projectOpenai(messages, config, policy, options)
    const thinking = record(record(options?.continuation).reasoningByCall)
    for (const row of result) if (row.role === 'assistant') for (const raw of array(row.tool_calls)) {
      const reasoning = text(thinking[text(record(raw).id)])
      if (reasoning) { row.reasoning_content = reasoning; break }
    }
    return result
  },
  stream,
  async complete(input, deps) {
    const { body } = requestBody(input, deps, false), response = await requestJson(deps, openaiHttpRequest(input, body, 'chat/completions'), input.signal)
    const choice = record(array(response.choices)[0]), message = record(choice.message)
    if (!Object.keys(choice).length || !Object.keys(message).length) throw new ProviderError('protocol', { requestStarted: true })
    const usage = normalizeOpenaiUsage(response.usage)
    reportUsage(deps, response.usage ?? null, usage)
    return { text: text(message.content), usage, finishReason: text(choice.finish_reason) || null, ...(choice.finish_reason === 'length' ? { incompleteReason: 'max_tokens' } : {}) }
  },
}
