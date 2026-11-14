import { observe } from '../values.js'
import type { CanonicalMessage, Json, ProviderEvent, ToolCall } from '../../harness/contracts.js'
import { isContextOverflowError } from '../../harness/context/budget.js'
import type { JsonObject, ProjectionOptions, ProtocolDriver, ProviderConfig, ProviderDriverDependencies, ProviderInvocation, ProviderPolicy, ResponsesInputCapabilities } from '../contracts.js'
import { classifyProviderError, ProviderError } from '../errors.js'
import { requestEvents, requestJson } from '../http.js'
import { plainContent, renderOpenaiHistory, stripCacheControl, transformOpenaiWireHistory } from './history.js'
import { normalizedToolCall, normalizeOpenaiUsage, openaiHttpRequest, unknownUsage } from './driver.js'
import { array, clone, finite, record, reportUsage, text } from '../values.js'

function contentEmpty(content: unknown): boolean {
  if (content === null || content === undefined) return true
  if (typeof content === 'string') return !content.trim()
  return Array.isArray(content) && content.every(part => ['text', 'input_text'].includes(text(record(part).type)) && !text(record(part).text).trim())
}

export function responsesContent(content: Json, capabilities: ResponsesInputCapabilities): Json {
  if (!Array.isArray(content)) return content || ''
  return content.map(raw => {
    const part = clone(record(raw)), type = text(part.type)
    if (type === 'text') return { ...part, type: 'input_text' } as JsonObject
    if (type === 'image_url' || type === 'input_image') {
      if (!capabilities.image) throw new ProviderError('unsupported')
      if (type === 'input_image') return part as JsonObject
      const image = record(part.image_url), detail = text(part.detail || image.detail)
      return { ...part, type: 'input_image', image_url: typeof part.image_url === 'string' ? part.image_url : text(image.url), ...(detail ? { detail } : {}) } as JsonObject
    }
    if (type === 'video_url' || type === 'input_video') {
      if (!capabilities.video) throw new ProviderError('unsupported')
      return { ...part, type: 'input_video', ...(type === 'video_url' ? { video_url: text(record(part.video_url).url) || text(part.video_url) } : {}) } as JsonObject
    }
    if (type === 'input_audio') {
      const audio = record(part.input_audio)
      if (!capabilities.audio_formats.length || !Object.keys(audio).length) throw new ProviderError('unsupported')
      let data = text(audio.data), format = text(audio.format).toLowerCase()
      if (data.startsWith('data:')) {
        const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(data)
        const expected = match ? ({ 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/flac': 'flac', 'audio/ogg': 'ogg' } as Record<string, string>)[match[1]!.toLowerCase()] : undefined
        if (!match || !expected || (format && format !== expected)) throw new ProviderError('unsupported')
        format = expected; data = match[2]!
      }
      if (!capabilities.audio_formats.includes(format)) throw new ProviderError('unsupported')
      return { ...part, input_audio: { ...audio, format, data } } as JsonObject
    }
    return part as JsonObject
  })
}

/** Responses 是独立 item 协议，不能只把 Chat 的路径改成 /responses。 */
export function responsesInput(messages: readonly JsonObject[], media: ResponsesInputCapabilities, digest?: (value: unknown) => string): JsonObject[] {
  const items: JsonObject[] = [], occurrences = new Map<string, number>()
  for (const message of messages) {
    if (['reasoning', 'function_call', 'function_call_output'].includes(text(message.type))) { items.push(clone(message)); continue }
    if (message.role === 'system') continue
    if (message.role === 'assistant' && array(message.tool_calls).length) {
      if (!contentEmpty(message.content)) items.push({ role: 'assistant', content: responsesContent(message.content!, media) })
      for (const raw of array(message.tool_calls)) {
        const call = record(raw), fn = record(call.function), id = text(call.id || call.call_id) || 'tool-call'
        let itemId = text(call.responses_item_id)
        if (!itemId) {
          if (!digest) throw new ProviderError('input_rejected')
          const occurrence = occurrences.get(id) ?? 0; occurrences.set(id, occurrence + 1)
          itemId = `fc_legacy_${digest({ call_id: id, occurrence }).slice(0, 24)}`
        }
        items.push({ type: 'function_call', id: itemId, call_id: id, name: text(fn.name) || 'unknown_tool', arguments: text(fn.arguments) || '{}' })
      }
    } else if (message.role === 'tool') items.push({ type: 'function_call_output', call_id: text(message.tool_call_id || message.call_id) || 'tool-call', output: message.content || '' })
    else if (message.role === 'user' || message.role === 'assistant') {
      const content = responsesContent(message.content ?? '', media)
      if (!contentEmpty(content)) items.push({ role: message.role, content })
    }
  }
  return items
}

export function insertResponsesReasoning(items: readonly JsonObject[], continuation: unknown): JsonObject[] {
  const source = record(continuation)
  const reasoning = array(source.reasoning_items ?? record(source.payload).reasoning_items).map(record).filter(item => item.type === 'reasoning' && (item.status === undefined || item.status === null || item.status === 'completed')).map(item => clone(item) as JsonObject)
  if (!reasoning.length) return clone([...items])
  let anchor = -1
  items.forEach((item, index) => { if (item.role === 'assistant' || item.type === 'function_call') anchor = index })
  if (anchor < 0) return clone([...items])
  while (anchor > 0 && (items[anchor - 1]!.role === 'assistant' || items[anchor - 1]!.type === 'function_call')) anchor--
  // 同一冻结 wire 再准备时不重复插入已存在的私有 item。
  const existing = new Set(items.filter(item => item.type === 'reasoning').map(item => text(item.id)))
  return [...clone(items.slice(0, anchor)), ...reasoning.filter(item => !text(item.id) || !existing.has(text(item.id))), ...clone(items.slice(anchor))]
}

export function responsesInstructions(history: readonly JsonObject[], stableSystem: string): { base: string; instructions: string } {
  const system = history.filter(row => row.role === 'system').map(row => plainContent(row.content).trim()).filter(Boolean), base = stableSystem.trim()
  if (base && system[0] && base.startsWith(system[0])) system.shift()
  return { base, instructions: [base, ...system].filter(Boolean).join('\n\n---\n\n') }
}

export function responsesOutputText(response: unknown): string {
  const value = record(response)
  if (value.output === undefined || value.output === null) return text(value.output_text)
  return array(value.output).map(record).filter(item => item.type === 'message').flatMap(item => array(item.content)).map(record).filter(part => part.type === 'output_text' || part.type === 'text').map(part => text(part.text)).join('')
}

export function responsesTools(tools: readonly JsonObject[]): JsonObject[] {
  return tools.flatMap(tool => {
    if (tool.type === 'function' && text(tool.name)) return [clone(tool)]
    const fn = record(tool.function)
    if (!text(fn.name)) return []
    return [{ type: 'function', name: text(fn.name), description: text(fn.description), parameters: (fn.parameters || { type: 'object' }) as JsonObject }]
  })
}

function requestBody(input: ProviderInvocation, deps: ProviderDriverDependencies, streaming: boolean): JsonObject {
  const media = input.policy.responsesInputCapabilities(input.config)
  const history = input.history.map(row => stripCacheControl(row) as JsonObject)
  const items = responsesInput(history, media, deps.digest)
  if (!items.length) throw new ProviderError('input_rejected')
  const parts = responsesInstructions(history, input.system)
  if (input.wireSystem !== undefined && typeof input.wireSystem !== 'string') throw new ProviderError('input_rejected')
  const base = parts.base, instructions = input.wireSystem === undefined ? parts.instructions : input.wireSystem
  const tools = responsesTools(input.tools)
  const body: JsonObject = { model: input.config.model, input: items, tools, ...input.policy.parameters(input.config, 'responses', input.purpose) }
  if (instructions) body.instructions = instructions
  const max = input.maxOutputTokens === undefined ? input.config.max_tokens : input.maxOutputTokens
  if (max !== undefined && max !== null) body.max_output_tokens = max
  const store = input.policy.responsesStore(input.config)
  if (store !== undefined) body.store = store
  if (input.policy.responsesPromptCacheKey(input.config)) body.prompt_cache_key = input.promptCacheKey || `gugu-${deps.digest({ model: input.config.model, base_instructions: base || instructions, tool_state_digest: deps.digest(tools) }).slice(0, 32)}`
  if (input.purpose === 'chat' && input.config.reasoning_persistence === 'continuation' && input.policy.responsesPromptCacheKey(input.config)) body.include = ['reasoning.encrypted_content']
  if (input.outputMode === 'json' && !input.hasHistory) {
    const format = record(input.policy.structuredOutput(input.config).response_format)
    if (format.type === 'json_object') body.text = { format: { type: 'json_object' } }
    if (format.type === 'json_schema' && text(record(format.json_schema).name) && Object.keys(record(record(format.json_schema).schema)).length) body.text = { format: { type: 'json_schema', ...record(format.json_schema) } } as JsonObject
  }
  if (streaming) body.stream = true
  return body
}

function failure(response: unknown, event: unknown, deps: ProviderDriverDependencies, outputStarted = false): never {
  const error = record(response).error || record(event).error || event
  observe(() => deps.diagnose?.('responses.failed', error))
  throw new ProviderError(isContextOverflowError(error) ? 'context_overflow' : 'upstream', { requestStarted: true, outputStarted })
}

async function* stream(input: ProviderInvocation, deps: ProviderDriverDependencies): AsyncGenerator<ProviderEvent> {
  const body = requestBody(input, deps, true)
  const items = new Map<string, { item: JsonObject; order: number }>(), args = new Map<string, string>()
  let output = '', status: string | null = null, incomplete: string | null = null, usage = unknownUsage, terminal = false
  try { for await (const event of requestEvents(deps, openaiHttpRequest(input, body, 'responses'), input.signal)) {
    const data = record(event.data), type = text(data.type) || event.event
    if (type === 'response.output_text.delta') { const delta = text(data.delta); output += delta; if (delta) yield { type: 'token', text: delta } }
    else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = record(data.item), key = text(item.id || item.call_id) || `index-${finite(data.output_index) ?? items.size}`
      if (Object.keys(item).length) items.set(key, { item: clone(item) as JsonObject, order: finite(data.output_index) ?? items.get(key)?.order ?? items.size })
    } else if (type === 'response.function_call_arguments.delta') { const id = text(data.item_id); args.set(id, (args.get(id) ?? '') + text(data.delta)) }
    else if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(type)) {
      const response = record(data.response)
      usage = normalizeOpenaiUsage(response.usage)
      reportUsage(deps, response.usage ?? null, usage)
      if (response.usage !== undefined) yield { type: 'usage', usage }
      if (type === 'error' || type === 'response.failed') failure(response, data, deps, !!output || items.size > 0 || args.size > 0)
      status = text(response.status) || (type === 'response.incomplete' ? 'incomplete' : 'completed')
      incomplete = text(record(response.incomplete_details).reason) || null
      array(response.output).forEach((raw, index) => { const item = record(raw), key = text(item.id || item.call_id) || `final-${index}`; items.set(key, { item: clone(item) as JsonObject, order: index }) })
      terminal = true
      if (!output) {
        const finalText = responsesOutputText(response)
        if (finalText) { output = finalText; yield { type: 'token', text: finalText } }
      }
      break
    }
  } } catch (error) {
    const classified = error instanceof ProviderError ? error : classifyProviderError(error)
    throw new ProviderError(classified.code, { ...classified.options, outputStarted: classified.options.outputStarted || !!output || items.size > 0 || args.size > 0 })
  }
  if (!terminal) throw new ProviderError('stream_incomplete', { requestStarted: true, outputStarted: !!output || items.size > 0 || args.size > 0 })
  const ordered = [...items.values()].sort((a, b) => a.order - b.order).map(value => value.item)
  const calls: ToolCall[] = ordered.filter(item => item.type === 'function_call').map(item => {
    const id = text(item.call_id || item.id), name = text(item.name)
    if (!id || !name) throw new ProviderError('protocol', { requestStarted: true, outputStarted: true })
    if (item.arguments !== undefined && item.arguments !== null && typeof item.arguments !== 'string') throw new ProviderError('protocol', { requestStarted: true, outputStarted: true })
    return normalizedToolCall(id, name, text(item.arguments) || args.get(text(item.id)) || '{}', text(item.id) || undefined)
  })
  const reasoning = ordered.filter(item => item.type === 'reasoning' && (item.status === undefined || item.status === null || item.status === 'completed'))
  yield { type: 'complete', text: output, calls, finishReason: status, incompleteReason: incomplete, requiresTools: calls.length > 0,
    ...(input.config.reasoning_persistence === 'continuation' && reasoning.length ? { continuation: { state_kind: 'openai_responses_reasoning', reasoning_items: clone(reasoning) } } : {}) }
}

export const responsesDriver: ProtocolDriver = {
  protocol: 'responses',
  transformHistory: (history, stage, protectedPrefixRows) => transformOpenaiWireHistory(history, stage, protectedPrefixRows, 'responses'),
  buildRequest: (input, deps, streaming) => openaiHttpRequest(input, requestBody(input, deps, streaming), 'responses'),
  project(messages: readonly CanonicalMessage[], config: ProviderConfig, policy: ProviderPolicy, options: ProjectionOptions = {}) {
    const media = policy.responsesInputCapabilities(config)
    const history = renderOpenaiHistory(messages, options, { image: media.image, audio: false, video: false, caption: '工具返回了以下图片，请结合工具文字结果继续处理。' }), systems = history.filter(row => row.role === 'system')
    const items = responsesInput(history, media, options.digest)
    return [...systems, ...(config.reasoning_persistence === 'continuation' && options.continuation ? insertResponsesReasoning(items, options.continuation) : items)]
  },
  stream,
  async complete(input, deps) {
    const body = requestBody(input, deps, false), response = await requestJson(deps, openaiHttpRequest(input, body, 'responses'), input.signal)
    const status = text(response.status)
    const usage = normalizeOpenaiUsage(response.usage)
    reportUsage(deps, response.usage ?? null, usage)
    if (status === 'failed' || response.error) failure(response, response, deps)
    if (!Array.isArray(response.output) && typeof response.output_text !== 'string') throw new ProviderError('protocol', { requestStarted: true })
    return { text: responsesOutputText(response), usage, finishReason: status || null, incompleteReason: text(record(response.incomplete_details).reason) || null }
  },
}
