import { observe } from '../values.js'
import { throwIfCancelled } from '../errors.js'
import type { CanonicalMessage, Json, ProviderEvent, ToolCall, Usage } from '../../harness/contracts.js'
import { renderCanonicalEvents } from '../../harness/history/canonical-history.js'
import type { JsonObject, ProtocolDriver, ProviderCompletion, ProviderConfig, ProviderDriverDependencies, ProviderHttpRequest, ProviderInvocation, ProjectionOptions } from '../contracts.js'
import { classifyProviderError, ProviderError } from '../errors.js'
import { endpoint, requestJson, requestNdjson } from '../http.js'
import { array, clone, finite, object, record, reportUsage, text } from '../values.js'
import { transformOpenaiWireHistory } from '../openai-history.js'

function parsedArguments(value: unknown): JsonObject {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { throw new ProviderError('protocol') }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('protocol')
  return object(value)
}
function resultText(value: unknown): string {
  if (!Array.isArray(value)) return typeof value === 'string' ? value : JSON.stringify(value ?? '')
  const parts = value.map(item => {
    const block = record(item), type = text(block.type)
    if (type === 'text') return text(block.text)
    if (type === 'image' || type === 'image_url') return '[图片结果已返回，但当前原生协议未发送工具图片]'
    if (['input_audio', 'audio', 'video', 'video_url'].includes(type)) return '[媒体内容已返回，但当前 API 协议不支持该工具媒体输入]'
    return JSON.stringify(item)
  }).filter(Boolean)
  return parts.join('\n') || '工具已执行。'
}

export function projectOllamaHistory(messages: readonly CanonicalMessage[], config: ProviderConfig, options: ProjectionOptions = {}): JsonObject[] {
  const result: JsonObject[] = [], pending = new Map<string, { name: string; call: JsonObject }>()
  const pairedCalls = new Set<JsonObject>()
  const stored = record(options.continuation)
  const thinkingByCall = stored.protocol === 'ollama' ? record(stored.thinkingByToolCallId) : {}
  const input = renderCanonicalEvents(messages)
  for (const message of input) {
    const role = text(message.role), content = message.content
    const blocks = Array.isArray(content) ? content.map(record) : []
    const parts: string[] = typeof content === 'string' ? [content] : []
    const images: Json[] = array(message.images) as Json[]
    const toolCalls: JsonObject[] = []
    if (role === 'assistant' && Array.isArray(message.tool_calls)) for (const call of message.tool_calls.map(record)) {
      const fn = record(call.function), id = text(call.id)
      if (!id || !text(fn.name)) throw new ProviderError('protocol')
      const projected = { id, type: 'function', function: { name: text(fn.name), arguments: parsedArguments(fn.arguments ?? {}) } }
      if (toolCalls.some(call => call.id === id)) throw new ProviderError('protocol')
      pending.set(id, { name: text(fn.name), call: projected }); toolCalls.push(projected)
    }
    const toolResults: { id: string; content: unknown; name?: string }[] = []
    for (const block of blocks) {
      const type = text(block.type)
      if (type === 'text') { if (text(block.text)) parts.push(text(block.text)); continue }
      if (type === 'tool_call' || type === 'tool_use') {
        const id = text(block.id), name = text(block.name)
        if (!id || !name) throw new ProviderError('protocol')
        const projected = { id, type: 'function', function: { name, arguments: parsedArguments(block.arguments ?? block.input ?? {}) } }
        if (toolCalls.some(call => call.id === id)) throw new ProviderError('protocol')
        pending.set(id, { name, call: projected }); toolCalls.push(projected)
        continue
      }
      if (type === 'tool_result') { toolResults.push({ id: text(block.tool_call_id || block.tool_use_id), content: block.content, name: text(block.tool_name) }); continue }
      if (type === 'image' || type === 'image_url') {
        if (!(config.capability_overrides?.image ?? config.image)) throw new ProviderError('unsupported')
        const source = record(block.source), url = text(record(block.image_url).url)
        if (type === 'image' && source.type === 'base64' && text(source.data)) images.push(text(source.data))
        else if (url.startsWith('data:') && url.includes(',')) images.push(url.slice(url.indexOf(',') + 1))
        else throw new ProviderError('unsupported')
        continue
      }
      if (['thinking', 'redacted_thinking', 'reasoning_content'].includes(type)) continue
      if (['input_audio', 'audio', 'video', 'video_url'].includes(type)) throw new ProviderError('unsupported')
      parts.push(JSON.stringify(block))
    }
    if (role === 'tool' && !toolResults.length) toolResults.push({ id: text(message.tool_call_id), content, name: text(message.tool_name) })
    if (parts.length || images.length || toolCalls.length) {
      const projected: JsonObject = { role, content: parts.join('\n') }
      if (images.length) projected.images = images
      if (toolCalls.length) projected.tool_calls = toolCalls
      const thinking = options.preserveNativeThinking ? text(message.thinking || message.reasoning_content) : ''
      const storedThinking = toolCalls.map(call => text(thinkingByCall[text(call.id)])).find(Boolean)
      if (thinking || storedThinking) projected.thinking = thinking || storedThinking!
      if (role !== 'tool') result.push(projected)
    }
    for (const toolResult of toolResults) {
      const match = pending.get(toolResult.id)
      if (!toolResult.id || !match) continue
      pairedCalls.add(match.call); pending.delete(toolResult.id)
      result.push({ role: 'tool', tool_name: toolResult.name || match.name, tool_call_id: toolResult.id, content: resultText(toolResult.content) })
    }
  }
  // 等待确认时只投影已经有回执的调用；不让未派发并行兄弟成为孤儿。
  return result.flatMap(message => {
    const kept = array(message.tool_calls).map(record).filter(call => pairedCalls.has(call as JsonObject))
    if (message.tool_calls && !kept.length && !text(message.content) && !array(message.images).length) return []
    const clean = clone(message)
    if (message.tool_calls) { if (kept.length) clean.tool_calls = kept as JsonObject[]; else delete clean.tool_calls }
    delete clean.tool_call_id
    return [clean]
  })
}

function request(input: ProviderInvocation, stream: boolean): ProviderHttpRequest {
  const config = input.config
  if (input.policy.name !== 'ollama' || input.policy.protocol(config) !== 'ollama') throw new ProviderError('unsupported')
  const key = config.api_key?.trim() || 'ollama'
  if (!/^[\x21-\x7e]+$/.test(key)) throw new ProviderError('authentication')
  const selected = config.reasoning_effort || 'medium'
  const think = config.thinking === 'adaptive' ? ['low', 'medium', 'high', 'max'].includes(selected) ? selected : 'medium' : false
  const history = clone([...input.history])
  const maximum = input.maxOutputTokens === undefined ? config.max_tokens : input.maxOutputTokens
  if (input.system && !(history[0]?.role === 'system' && history[0]?.content === input.system)) history.unshift({ role: 'system', content: input.system })
  const body: JsonObject = {
    model: config.model, messages: history, stream, think,
    keep_alive: typeof config.ollama_keep_alive === 'string' && config.ollama_keep_alive || '5m',
    options: maximum == null ? {} : { num_predict: maximum },
  }
  if (input.tools.length) body.tools = clone([...input.tools])
  if (input.outputMode === 'json' && !input.hasHistory) body.format = 'json'
  // URL兼容推断只选择协议，不能把包含11434/ollama的任意地址变成内网授权。
  const explicitlyLocal = ['local', 'ollama'].includes((config.provider || '').trim().toLowerCase())
  return { url: endpoint(input.policy.baseUrl(config), 'chat'), method: 'POST', body, timeoutMs: config.timeout_ms,
    allowLocal: explicitlyLocal && config.ollama_mode !== 'cloud', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...input.policy.headers(config) } }
}
function usage(chunk: Record<string, unknown>): Usage {
  const input = finite(chunk.prompt_eval_count), output = finite(chunk.eval_count)
  return { input: input ?? 0, output: output ?? 0, cacheRead: 0, cacheWrite: 0, contextInput: input }
}
function rawUsage(chunk: Record<string, unknown>): Record<string, unknown> | null {
  const fields = ['prompt_eval_count', 'eval_count', 'total_duration', 'load_duration', 'prompt_eval_duration', 'eval_duration']
  const values = Object.fromEntries(fields.filter(field => field in chunk).map(field => [field, clone(chunk[field])]))
  return Object.keys(values).length ? values : null
}
function appendCalls(chunk: Record<string, unknown>, calls: ToolCall[], wire: JsonObject[], idPrefix: string): void {
  for (const value of array(record(chunk.message).tool_calls)) {
    const call = record(value), fn = record(call.function), name = text(fn.name)
    if (!name) continue
    const input = parsedArguments(fn.arguments ?? {}), id = text(call.id) || `${idPrefix}-${calls.length}`
    const previous = calls.find(item => item.id === id)
    if (previous) { if (previous.name !== name || JSON.stringify(previous.input) !== JSON.stringify(input)) throw new ProviderError('protocol', { requestStarted: true }); continue }
    calls.push({ id, name, input, ...(typeof fn.arguments === 'string' ? { rawArguments: fn.arguments } : {}) })
    wire.push({ id, type: 'function', function: { name, arguments: input } })
  }
}
function continuation(input: ProviderInvocation, thinking: string, calls: readonly ToolCall[], wire: JsonObject[], content: string): JsonObject {
  const stored = record(input.continuation)
  const previous = stored.protocol === 'ollama' ? record(stored.thinkingByToolCallId) : {}
  return { protocol: 'ollama', thinkingByToolCallId: { ...previous, ...Object.fromEntries(calls.map(call => [call.id, thinking])) } as JsonObject,
    assistant: { role: 'assistant', content, ...(thinking ? { thinking } : {}), ...(wire.length ? { tool_calls: wire } : {}) } }
}

export const ollamaDriver: ProtocolDriver = {
  protocol: 'ollama', project: (messages, config, _policy, options) => projectOllamaHistory(messages, config, options),
  buildRequest: (input, _dependencies, streaming) => request(input, streaming),
  transformHistory: (history, stage, protectedPrefixRows) => transformOpenaiWireHistory(history, stage, protectedPrefixRows, 'ollama'),
  async *stream(input: ProviderInvocation, dependencies: ProviderDriverDependencies): AsyncIterable<ProviderEvent> {
    let content = '', thinking = '', finished = false
    const calls: ToolCall[] = [], wire: JsonObject[] = []
    const idPrefix = `ollama-call-${dependencies.digest([input.scope.ownerId, input.scope.sessionId, input.scope.runId, input.scope.round]).slice(0, 24)}`
    try { for await (const chunk of requestNdjson(dependencies, request(input, true), input.signal)) {
      throwIfCancelled(input.signal)
      if (chunk.error) { observe(() => dependencies.diagnose?.('ollama_stream_error', chunk.error)); throw new ProviderError('upstream', { requestStarted: true, outputStarted: !!content || !!thinking || calls.length > 0 }) }
      const message = record(chunk.message), delta = text(message.content)
      if (delta) { content += delta; yield { type: 'token', text: delta } }
      thinking += text(message.thinking)
      appendCalls(chunk, calls, wire, idPrefix)
      if (chunk.done === true) {
        finished = true
        const normalized = usage(chunk)
        reportUsage(dependencies, rawUsage(chunk), normalized)
        yield { type: 'usage', usage: normalized }
        throwIfCancelled(input.signal)
        yield { type: 'complete', text: content, calls, requiresTools: calls.length > 0, continuation: continuation(input, thinking, calls, wire, content), finishReason: text(chunk.done_reason) || null }
        break
      }
    } } catch (raw) {
      const error = input.signal.aborted ? new ProviderError('cancelled') : classifyProviderError(raw)
      throw new ProviderError(error.code, { ...error.options, outputStarted: error.options.outputStarted || !!content || !!thinking || calls.length > 0 })
    }
    if (!finished) throw new ProviderError('stream_incomplete', { requestStarted: true, outputStarted: !!content || !!thinking || calls.length > 0 })
  },
  async complete(input: ProviderInvocation, dependencies: ProviderDriverDependencies): Promise<ProviderCompletion> {
    const chunk = await requestJson(dependencies, request(input, false), input.signal)
    if (chunk.error || chunk.done !== true) throw new ProviderError(chunk.error ? 'upstream' : 'stream_incomplete', { requestStarted: true })
    const normalized = usage(chunk)
    reportUsage(dependencies, rawUsage(chunk), normalized)
    return { text: text(record(chunk.message).content), usage: normalized, finishReason: text(chunk.done_reason) || null }
  },
}
