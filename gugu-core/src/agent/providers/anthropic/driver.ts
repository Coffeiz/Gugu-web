import { observe } from '../values.js'
import type { Json, ProviderEvent, ToolCall, Usage } from '../../harness/contracts.js'
import { createPolicy, DEFAULT_CAPABILITIES, DEFAULT_REASONING, genericThinkingParams, normalizeBaseUrl, reasoningEffort } from '../base.js'
import type { JsonObject, ProviderCompletion, ProviderConfig, ProviderDriverDependencies, ProviderHttpRequest, ProviderInvocation, ProtocolDriver, ReasoningCapabilities } from '../contracts.js'
import { classifyProviderError, ProviderError } from '../errors.js'
import { endpoint, requestEvents, requestJson } from '../http.js'
import { projectAnthropicHistory, sanitizeAnthropicHistory, transformAnthropicWireHistory } from './history.js'
import { parsePartialAnthropicObject } from './json.js'
import { abort, array, clone, finite, object, record, reportUsage, text } from '../values.js'

function reasoning(config: ProviderConfig, protocol: string): ReasoningCapabilities {
  if (protocol !== 'anthropic') return DEFAULT_REASONING
  let hostname: string
  try { hostname = new URL(config.base_url || 'https://api.anthropic.com/v1').hostname } catch { return DEFAULT_REASONING }
  if (hostname !== 'api.anthropic.com') return DEFAULT_REASONING
  const model = config.model.trim().toLowerCase()
  let efforts: readonly string[] = []
  if (model.startsWith('claude-opus-5')) efforts = ['low', 'medium', 'high', 'xhigh', 'max']
  else if (model.startsWith('claude-opus-4-8')) efforts = ['low', 'medium', 'high', 'xhigh']
  else if (['claude-opus-4-6', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-sonnet-5'].some(prefix => model.startsWith(prefix))) efforts = ['low', 'medium', 'high']
  else if (!['claude-fable-5', 'claude-mythos-5'].some(prefix => model.startsWith(prefix))) return DEFAULT_REASONING
  return { modes: ['adaptive'], efforts, supports_adaptive_thinking: true }
}

export const anthropicPolicy = createPolicy('anthropic', {
  capabilities: config => ({ ...DEFAULT_CAPABILITIES, api_format: 'anthropic', cache_mode: 'active', thinking: reasoning({ ...config, base_url: undefined }, 'anthropic').modes.length > 0 }),
  baseUrl: config => normalizeBaseUrl(config.base_url || 'https://api.anthropic.com/v1'),
  reasoningCapabilities: reasoning,
  parameters: (config, protocol) => {
    const generic = genericThinkingParams(config, protocol)
    if (Object.keys(generic).length) return generic
    const supported = reasoning(config, protocol), effort = reasoningEffort(config, supported)
    return { ...(supported.modes.includes(config.thinking ?? '') ? { thinking: { type: config.thinking! } } : {}), ...(effort ? { output_config: { effort } } : {}) }
  },
})

/** 协议响应块只交给调用方受限暂存；正文边界和原生签名不能持久化为 Canonical。 */
interface ThinkingState {
  state_kind: 'anthropic_thinking_blocks'
  model_identity: string
  owner_id: string
  session_id: string
  access_scope_hash: string
  provider: string
  payload: {
    history_thinking_by_tool_id: Record<string, JsonObject[]>
    tail_blocks: JsonObject[] | null
    /** 保留原生响应的块边界，不能依赖 Canonical 合并后的 text 重建 wire。 */
    history_response_blocks_by_tool_id?: Record<string, JsonObject[]>
    tail_response_blocks?: JsonObject[] | null
  }
}

function thinkingState(input: ProviderInvocation): ThinkingState | null {
  const state = record(input.continuation), payload = record(state.payload)
  if (state.state_kind !== 'anthropic_thinking_blocks'
    || state.model_identity !== input.scope.modelIdentity || state.owner_id !== input.scope.ownerId
    || state.session_id !== input.scope.sessionId || state.access_scope_hash !== input.scope.accessScopeHash
    || state.provider !== input.policy.name) return null
  const native = (values: unknown) => Array.isArray(values) && values.every(value => ['thinking', 'redacted_thinking'].includes(text(record(value).type)))
  if (!payload.history_thinking_by_tool_id || typeof payload.history_thinking_by_tool_id !== 'object' || Array.isArray(payload.history_thinking_by_tool_id)) return null
  const history = record(payload.history_thinking_by_tool_id)
  if (Object.values(history).some(value => !native(value)) || payload.tail_blocks != null && !native(payload.tail_blocks)) return null
  const responseBlocks = (values: unknown) => Array.isArray(values) && values.every(value => ['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(text(record(value).type)))
  if (Object.values(record(payload.history_response_blocks_by_tool_id)).some(value => !responseBlocks(value))
    || payload.tail_response_blocks != null && !responseBlocks(payload.tail_response_blocks)) return null
  const result = clone(state) as unknown as ThinkingState
  const currentCalls = new Set(input.history.flatMap(message => array(message.content).flatMap(value => record(value).type === 'tool_use' ? [text(record(value).id)] : [])))
  result.payload.history_thinking_by_tool_id = Object.fromEntries(Object.entries(result.payload.history_thinking_by_tool_id).filter(([id]) => currentCalls.has(id)))
  result.payload.history_response_blocks_by_tool_id = Object.fromEntries(Object.entries(result.payload.history_response_blocks_by_tool_id ?? {}).filter(([id]) => currentCalls.has(id)))
  return result
}

function preserveTrailingCache(original: readonly JsonObject[], restored: JsonObject[]): JsonObject[] {
  const cache = original.at(-1)?.cache_control
  if (cache && restored.length) restored[restored.length - 1] = { ...restored.at(-1)!, cache_control: clone(cache) }
  return restored
}

function restoreThinking(history: readonly JsonObject[], input: ProviderInvocation): JsonObject[] {
  const result = clone([...history]), state = thinkingState(input)
  if (!state) return result
  for (const message of result) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const blocks = message.content as JsonObject[]
    const visible = (values: readonly JsonObject[]) => values.filter(block => block.type === 'text').map(block => text(block.text)).join('')
    const existingCalls = new Map(blocks.filter(block => block.type === 'tool_use').map(block => [text(block.id), block]))
    const response = [...existingCalls.keys()].map(id => state.payload.history_response_blocks_by_tool_id?.[id]).find(Boolean)
    if (response && visible(response) === visible(blocks)) {
      // 只复用确实保留于Canonical的调用；确认门未派发的siblings不能借私有wire复活。
      message.content = preserveTrailingCache(blocks, response.flatMap(block => block.type === 'tool_use'
        ? existingCalls.has(text(block.id)) ? [clone(existingCalls.get(text(block.id))!)] : []
        : [clone(block)]))
      continue
    }
    if (blocks.some(block => ['thinking', 'redacted_thinking'].includes(text(block.type)))) continue
    for (const call of blocks) {
      const saved = call.type === 'tool_use' ? state.payload.history_thinking_by_tool_id[text(call.id)] : undefined
      if (!saved?.length) continue
      for (const [offset, value] of saved.entries()) {
        const block = clone(value), rawPosition = block._block_position
        delete block._block_position
        const position = typeof rawPosition === 'number' && Number.isSafeInteger(rawPosition) && rawPosition >= 0 ? rawPosition : offset
        blocks.splice(Math.min(position, blocks.length), 0, block)
      }
      break
    }
  }
  const tailResponse = state.payload.tail_response_blocks
  if (tailResponse?.length) {
    const responseText = tailResponse.filter(block => block.type === 'text').map(block => text(block.text)).join('')
    const lastAssistant = result.findLast(message => message.role === 'assistant')
    const assistantText = typeof lastAssistant?.content === 'string' ? lastAssistant.content
      : array(lastAssistant?.content).filter(value => record(value).type === 'text').map(value => text(record(value).text)).join('')
    if (lastAssistant && responseText && responseText === assistantText) {
      lastAssistant.content = preserveTrailingCache(array(lastAssistant.content).map(object), clone(tailResponse))
      return result
    }
  }
  const tail = state.payload.tail_blocks
  if (tail?.length && !result.some(message => message.role === 'assistant' && JSON.stringify(message.content) === JSON.stringify(tail))) {
    const index = result.at(-1)?.role === 'user' ? result.length - 1 : result.length
    result.splice(index, 0, { role: 'assistant', content: clone(tail) })
  }
  return result
}

function captureThinking(blocks: readonly JsonObject[], input: ProviderInvocation): ThinkingState | undefined {
  const previous = thinkingState(input), history = clone(previous?.payload.history_thinking_by_tool_id ?? {})
  const responses = clone(previous?.payload.history_response_blocks_by_tool_id ?? {})
  let tail = clone(previous?.payload.tail_blocks ?? null)
  let tailResponse = clone(previous?.payload.tail_response_blocks ?? null)
  const native = blocks.flatMap((block, position) => ['thinking', 'redacted_thinking'].includes(text(block.type)) ? [{ ...clone(block), _block_position: position }] : [])
  const firstTool = blocks.find(block => block.type === 'tool_use' && text(block.id))
  if (firstTool) {
    // 同批第一项可能尚未派发，任何保留项都能找回该轮；发送时再按真实调用集合过滤。
    for (const call of blocks.filter(block => block.type === 'tool_use' && text(block.id))) responses[text(call.id)] = clone([...blocks])
    if (native.length) history[text(firstTool.id)] = native
    tail = null; tailResponse = null
  } else if (blocks.length && (native.length || previous)) {
    tailResponse = clone([...blocks])
    tail = native.length ? native.map(block => { const copy: JsonObject = { ...block }; delete copy._block_position; return copy }) : null
  }
  if (!Object.keys(history).length && !Object.keys(responses).length && !tail?.length && !tailResponse?.length) return undefined
  return { state_kind: 'anthropic_thinking_blocks', model_identity: input.scope.modelIdentity, owner_id: input.scope.ownerId,
    session_id: input.scope.sessionId, access_scope_hash: input.scope.accessScopeHash, provider: input.policy.name,
    payload: { history_thinking_by_tool_id: history, tail_blocks: tail, history_response_blocks_by_tool_id: responses, tail_response_blocks: tailResponse } }
}

function toolSchemas(input: ProviderInvocation): JsonObject[] {
  return input.tools.map(value => {
    const tool = record(value.function ?? value)
    if (!text(tool.name)) throw new ProviderError('input_rejected')
    return { name: text(tool.name), ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      input_schema: object(tool.input_schema ?? tool.parameters ?? {}), ...(tool.cache_control ? { cache_control: clone(tool.cache_control) as Json } : {}) }
  })
}

export function anthropicRequest(input: ProviderInvocation, streaming: boolean): ProviderHttpRequest {
  abort(input.signal)
  const activeCache = input.policy.capabilities(input.config).cache_mode === 'active'
  const system: Json = input.wireSystem !== undefined ? clone(input.wireSystem)
    : input.system && activeCache ? [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }] : input.system
  const parameters = input.policy.parameters(input.config, 'anthropic', input.purpose)
  const json = input.outputMode === 'json' && !input.hasHistory ? input.policy.structuredOutput(input.config) : {}
  // Python追加分支以32768表达None；Anthropic协议本身必填有限max_tokens。
  if (input.maxOutputTokens === null && input.purpose !== 'branch') throw new ProviderError('unsupported')
  const maxTokens = input.maxOutputTokens === null ? 32768 : input.maxOutputTokens ?? input.config.max_tokens ?? 8192
  const tools = toolSchemas(input)
  return {
    url: endpoint(input.policy.baseUrl(input.config), input.policy.baseUrl(input.config).endsWith('/v1') ? 'messages' : 'v1/messages'), method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(input.config.api_key ? { 'x-api-key': input.config.api_key } : {}), ...input.policy.headers(input.config) },
    body: { ...parameters, ...json, model: input.config.model, max_tokens: maxTokens,
      ...(input.wireSystem !== undefined || system || input.purpose === 'chat' ? { system } : {}),
      messages: sanitizeAnthropicHistory(restoreThinking(input.history, input)),
      ...(tools.length || input.purpose === 'chat' ? { tools } : {}), ...(streaming ? { stream: true } : {}) },
    timeoutMs: input.config.timeout_ms,
    allowLocal: ['local', 'ollama'].includes(input.config.provider?.trim().toLowerCase() ?? ''),
  }
}

export function anthropicUsage(value: unknown, previous?: Usage): Usage {
  const usage = record(value), fresh = finite(usage.input_tokens), read = finite(usage.cache_read_input_tokens), write = finite(usage.cache_creation_input_tokens)
  const input = fresh ?? previous?.input ?? 0, cacheRead = read ?? previous?.cacheRead ?? 0, cacheWrite = write ?? previous?.cacheWrite ?? 0
  return { input, cacheRead, cacheWrite, output: finite(usage.output_tokens) ?? previous?.output ?? 0,
    contextInput: fresh !== null || previous?.contextInput != null ? input + cacheRead + cacheWrite : null }
}

function normalizedToolName(value: unknown): string {
  const name = text(value), index = name.search(/[\[\]<>"\n\\`]/)
  return (index < 0 ? name : name.slice(0, index)).trim()
}

/** SDK partial JSON 的等价有限恢复，不把尚未接收完整的字段猜测为真实参数。 */
export function parseAnthropicToolInput(raw: string): JsonObject {
  return parsePartialAnthropicObject(raw)
}

function calls(blocks: readonly JsonObject[]): ToolCall[] {
  if (blocks.some(block => !['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(text(block.type)))) throw new ProviderError('protocol')
  const result = blocks.filter(block => block.type === 'tool_use').map(block => {
    const id = text(block.id), name = normalizedToolName(block.name)
    if (!id || !name) throw new ProviderError('protocol')
    if (block.input != null && (typeof block.input !== 'object' || Array.isArray(block.input))) throw new ProviderError('protocol')
    const input = object(block.input)
    return { id, name, input, rawArguments: JSON.stringify(input) }
  })
  if (new Set(result.map(call => call.id)).size !== result.length) throw new ProviderError('protocol')
  return result
}

function result(message: Record<string, unknown>, input: ProviderInvocation, dependencies: ProviderDriverDependencies): ProviderCompletion & { calls: ToolCall[] } {
  if (message.error) {
    observe(() => dependencies.diagnose?.('anthropic_error_response', message.error))
    throw classifyProviderError({ body: message }, { requestStarted: true, providerUrl: input.policy.baseUrl(input.config) })
  }
  if (!Array.isArray(message.content)) throw new ProviderError('protocol')
  const blocks = message.content.map(object)
  const finishReason = text(message.stop_reason) || null
  const usage = anthropicUsage(message.usage)
  reportUsage(dependencies, message.usage ?? null, usage)
  return { text: blocks.filter(block => block.type === 'text').map(block => text(block.text)).join(''), calls: calls(blocks),
    usage, finishReason, incompleteReason: finishReason === 'max_tokens' ? 'max_tokens' : null,
    continuation: captureThinking(blocks, input) }
}

class MissingContentBlock extends Error {
  constructor(readonly eventType: string, readonly index: number, readonly blockCount: number) { super('模型流内容块缺失') }
}

async function* stream(input: ProviderInvocation, dependencies: ProviderDriverDependencies): AsyncGenerator<ProviderEvent> {
  const blocks = new Map<number, { block: JsonObject; raw: string; closed: boolean }>()
  let started = false, stopped = false, visible = '', partialOutput = false, finishReason: string | null = null
  let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextInput: null }
  let rawUsage: unknown = null
  try {
    for await (const item of requestEvents(dependencies, anthropicRequest(input, true), input.signal)) {
      abort(input.signal)
      const event = record(item.data), type = text(event.type) || item.event
      if (type === 'ping') continue
      // 先记录已收到的输出事实；缺块不能让带内容的delta被误判为“尚无输出”。
      if (type === 'content_block_delta') {
        const received = record(event.delta)
        if (text(received.text) || text(received.partial_json) || text(received.thinking) || text(received.signature)) partialOutput = true
      } else if (type === 'content_block_start') {
        const received = record(event.content_block)
        if (text(received.text) || ['tool_use', 'thinking', 'redacted_thinking'].includes(text(received.type))) partialOutput = true
      }
      if (type === 'error') {
        observe(() => dependencies.diagnose?.('anthropic_sse_error', event.error))
        throw classifyProviderError({ body: { error: event.error } }, { requestStarted: true, providerUrl: input.policy.baseUrl(input.config) })
      }
      if (type === 'message_start') {
        if (started) throw new ProviderError('protocol')
        started = true
        const message = record(event.message)
        for (const [index, block] of array(message.content).entries()) {
          blocks.set(index, { block: object(block), raw: '', closed: true })
          if (text(record(block).text) || ['tool_use', 'thinking', 'redacted_thinking'].includes(text(record(block).type))) partialOutput = true
        }
        rawUsage = clone(message.usage ?? null)
        usage = anthropicUsage(rawUsage)
        reportUsage(dependencies, rawUsage, usage)
        if (Object.keys(record(message.usage)).length) yield { type: 'usage', usage }
        continue
      }
      if (!started) throw new ProviderError('protocol', { requestStarted: true, outputStarted: partialOutput, retryable: false })
      if (type === 'content_block_start') {
        const index = finite(event.index)
        if (index === null || !Number.isInteger(index) || index !== blocks.size) throw new ProviderError('protocol')
        const block = object(event.content_block)
        if (!['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(text(block.type))) throw new ProviderError('protocol')
        blocks.set(index, { block, raw: '', closed: false })
        if (block.type === 'text' && text(block.text)) { visible += text(block.text); yield { type: 'token', text: text(block.text) } }
      } else if (type === 'content_block_delta' || type === 'content_block_stop') {
        const index = finite(event.index), block = index === null ? undefined : blocks.get(index)
        if (!block) throw new MissingContentBlock(type, index ?? -1, blocks.size)
        if (block.closed) throw new ProviderError('protocol')
        if (type === 'content_block_stop') {
          block.closed = true
          if (block.block.type === 'tool_use' && block.raw) block.block.input = parseAnthropicToolInput(block.raw)
          continue
        }
        const delta = record(event.delta), deltaType = text(delta.type)
        if (deltaType === 'text_delta' && block.block.type === 'text') {
          const addition = text(delta.text)
          block.block.text = text(block.block.text) + addition
          if (addition) { visible += addition; yield { type: 'token', text: addition } }
        } else if (deltaType === 'input_json_delta' && block.block.type === 'tool_use') block.raw += text(delta.partial_json)
        else if (deltaType === 'thinking_delta' && block.block.type === 'thinking') block.block.thinking = text(block.block.thinking) + text(delta.thinking)
        else if (deltaType === 'signature_delta' && block.block.type === 'thinking') block.block.signature = text(block.block.signature) + text(delta.signature)
        else throw new ProviderError('protocol')
      } else if (type === 'message_delta') {
        finishReason = text(record(event.delta).stop_reason) || finishReason
        usage = anthropicUsage(event.usage, usage)
        if (Object.hasOwn(event, 'usage')) {
          if (event.usage != null) rawUsage = { ...record(rawUsage), ...record(event.usage) }
          reportUsage(dependencies, rawUsage, usage)
          yield { type: 'usage', usage }
        }
      } else if (type === 'message_stop') {
        if ([...blocks.values()].some(value => !value.closed)) throw new ProviderError('stream_incomplete', { requestStarted: true, outputStarted: !!visible || partialOutput })
        stopped = true
        break
      } else if (type !== 'done') throw new ProviderError('protocol')
    }
    if (!stopped) throw new ProviderError('stream_incomplete', { requestStarted: true, outputStarted: !!visible || partialOutput })
    const responseBlocks = [...blocks.values()].map(value => value.block)
    reportUsage(dependencies, rawUsage, usage)
    // 当前attempt缺报时也要覆盖旧attempt的用量，不得借前次实际输入触发压缩。
    yield { type: 'usage', usage }
    yield { type: 'complete', text: responseBlocks.filter(block => block.type === 'text').map(block => text(block.text)).join(''),
      calls: calls(responseBlocks), finishReason, incompleteReason: finishReason === 'max_tokens' ? 'max_tokens' : null,
      continuation: captureThinking(responseBlocks, input), cacheAnchor: input.cacheAnchor }
  } catch (error) {
    if (input.signal.aborted) throw new ProviderError('cancelled', { requestStarted: started, outputStarted: !!visible || partialOutput })
    if (error instanceof MissingContentBlock && !visible && !partialOutput) {
      observe(() => dependencies.diagnose?.('anthropic_missing_content_block', { eventType: error.eventType, index: error.index, blockCount: error.blockCount }))
      try {
        const recovered = result(await requestJson(dependencies, anthropicRequest(input, false), input.signal), input, dependencies)
        if (recovered.text) yield { type: 'token', text: recovered.text }
        yield { type: 'usage', usage: recovered.usage }
        yield { type: 'complete', ...recovered, cacheAnchor: input.cacheAnchor }
        return
      } catch (recoveryError) {
        if (input.signal.aborted) throw new ProviderError('cancelled')
        observe(() => dependencies.diagnose?.('anthropic_nonstream_recovery_failed', recoveryError))
        throw recoveryError instanceof ProviderError ? new ProviderError(recoveryError.code, { ...recoveryError.options, retryable: false })
          : new ProviderError('protocol', { requestStarted: true, retryable: false })
      }
    }
    if (error instanceof ProviderError) throw new ProviderError(error.code, { ...error.options, outputStarted: error.options.outputStarted || !!visible || partialOutput })
    observe(() => dependencies.diagnose?.('anthropic_stream_protocol_failure', error))
    throw new ProviderError('protocol', { requestStarted: started, outputStarted: !!visible || partialOutput, retryable: false })
  }
}

export const anthropicDriver: ProtocolDriver = {
  protocol: 'anthropic',
  buildRequest: (input, _dependencies, streaming) => anthropicRequest(input, streaming),
  project: projectAnthropicHistory,
  transformHistory: transformAnthropicWireHistory,
  stream,
  async complete(input, dependencies) { return result(await requestJson(dependencies, anthropicRequest(input, false), input.signal), input, dependencies) },
}
