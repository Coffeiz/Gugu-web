import type { CanonicalMessage, Json } from '../harness/contracts.js'
import { renderCanonicalEvents, stableJson } from '../harness/history/canonical-history.js'
import type { HistorySanitization, JsonObject, ProjectionOptions, ProviderConfig, ProviderPolicy, WireTransformStage } from './contracts.js'
import { ProviderError } from './errors.js'
import { array, clone, record, text } from './values.js'

function resultContent(value: unknown, enabled?: { image: boolean; audio: boolean; video: boolean }): { content: string; media: JsonObject[] } {
  if (!Array.isArray(value)) return { content: typeof value === 'string' ? value : JSON.stringify(value ?? null), media: [] }
  const parts: string[] = [], media: JsonObject[] = []
  for (const raw of value) {
    const block = record(raw), kind = text(block.type)
    if (kind === 'text') { if (text(block.text)) parts.push(text(block.text)); continue }
    if (['image', 'image_url', 'input_audio', 'video_url'].includes(kind)) {
      const modality = kind === 'input_audio' ? 'audio' : kind === 'video_url' ? 'video' : 'image'
      if (enabled && !enabled[modality]) {
        parts.push(modality === 'image' ? '[图片结果已返回，但当前模型不支持视觉输入]' : `[${modality === 'audio' ? '音频' : '视频'}内容已返回，但当前 API 协议不支持原生${modality === 'audio' ? '音频' : '视频'}输入]`)
        continue
      }
      media.push(mediaBlock(block)); continue
    }
    parts.push(JSON.stringify(raw))
  }
  return { content: parts.join('\n') || '工具已执行。', media }
}

function mediaBlock(block: Record<string, unknown>): JsonObject {
  if (block.type === 'image') {
    const source = record(block.source)
    if (source.type === 'base64' && text(source.data)) return { type: 'image_url', image_url: { url: `data:${text(source.media_type) || 'image/jpeg'};base64,${source.data}`, detail: 'auto' } }
    if (source.type === 'url' && text(source.url)) return { type: 'image_url', image_url: { url: text(source.url) } }
  }
  return clone(block) as JsonObject
}

/** 将 Canonical 语义投影成 Chat wire；不修改输入，不携带 Area 私有元数据。 */
export function renderOpenaiHistory(messages: readonly CanonicalMessage[], options: ProjectionOptions = {}, toolMedia?: { image: boolean; audio: boolean; video: boolean; caption?: string }): JsonObject[] {
  const result: JsonObject[] = []
  for (const rendered of renderCanonicalEvents(clone([...messages]))) {
    const role = rendered.role
    const content = rendered.content
    if (!Array.isArray(content)) {
      const row: JsonObject = { role, content: content ?? '' }
      if (role === 'tool') row.tool_call_id = text(rendered.tool_call_id || rendered.call_id)
      if (role === 'assistant' && Array.isArray(rendered.tool_calls)) row.tool_calls = clone(rendered.tool_calls)
      if (options.preserveNativeThinking && text(rendered.reasoning_content)) row.reasoning_content = text(rendered.reasoning_content)
      result.push(row); continue
    }
    const calls: JsonObject[] = [], body: Json[] = [], tools: JsonObject[] = [], media: JsonObject[] = []
    for (const raw of content) {
      const block = record(raw), kind = text(block.type)
      if (kind === 'tool_call' || kind === 'tool_use') {
        const input = block.arguments ?? block.input ?? {}
        const call: JsonObject = { id: text(block.id) || 'tool-call', type: 'function', function: { name: text(block.name) || 'unknown_tool', arguments: typeof input === 'string' ? input : JSON.stringify(input) } }
        if (text(block.responses_item_id)) call.responses_item_id = text(block.responses_item_id)
        calls.push(call)
      } else if (kind === 'tool_result') {
        const value = resultContent(block.content, toolMedia)
        tools.push({ role: 'tool', tool_call_id: text(block.tool_call_id || block.tool_use_id), content: value.content })
        media.push(...value.media)
      } else if (['thinking', 'redacted_thinking', 'reasoning_content'].includes(kind)) {
        // 原生私有推理由单独续接材料注入，不从持久 Canonical 恢复。
      } else body.push(mediaBlock(block))
    }
    if (body.length || calls.length || !tools.length) {
      const row: JsonObject = { role: role === 'tool' ? 'user' : role, content: body }
      if (calls.length) { row.role = 'assistant'; row.tool_calls = calls; if (!body.length) row.content = null }
      if (options.preserveNativeThinking && text(rendered.reasoning_content)) row.reasoning_content = text(rendered.reasoning_content)
      result.push(row)
    }
    result.push(...tools)
    if (media.length) result.push({ role: 'user', content: [{ type: 'text', text: toolMedia?.caption ?? '工具返回了以下多模态内容，请结合工具文字结果继续处理。' }, ...media] })
  }
  return result
}

/** 截断历史只保留完整的相邻调用/结果，重复 id 只保留首个；不会重排真实消息。 */
export function sanitizeOpenaiToolHistory(messages: readonly JsonObject[], onSanitization?: (value: HistorySanitization) => void): JsonObject[] {
  const output: JsonObject[] = [], retained: number[] = []
  const emit = (row: JsonObject, index: number) => { output.push(row); retained.push(index) }
  for (let index = 0; index < messages.length;) {
    const message = clone(messages[index]!), calls = array(message.tool_calls).map(record)
    if (message.role !== 'assistant' || !calls.length) {
      if (message.role !== 'tool') emit(message, index)
      index++; continue
    }
    const byId = new Map<string, Record<string, unknown>>()
    for (const call of calls) if (text(call.id) && !byId.has(text(call.id))) byId.set(text(call.id), call)
    const results: JsonObject[] = []; let cursor = index + 1
    while (cursor < messages.length && messages[cursor]!.role === 'tool') results.push(clone(messages[cursor++]!))
    const matched = new Set(results.map(row => text(row.tool_call_id)).filter(id => byId.has(id)))
    if (matched.size) {
      message.tool_calls = [...byId.entries()].filter(([id]) => matched.has(id)).map(([, call]) => call as JsonObject)
      emit(message, index)
      const emitted = new Set<string>()
      results.forEach((row, offset) => { const id = text(row.tool_call_id); if (matched.has(id) && !emitted.has(id)) { emit(row, index + offset + 1); emitted.add(id) } })
    } else if ((Array.isArray(message.content) ? message.content.length > 0 : !!message.content) && (typeof message.content !== 'string' || message.content.trim())) { delete message.tool_calls; emit(message, index) }
    index = cursor
  }
  if (onSanitization) {
    const indexes = new Set(retained), removed = messages.flatMap((_, index) => indexes.has(index) ? [] : [index])
    const modified = retained.filter((index, clean) => stableJson(messages[index]) !== stableJson(output[clean]))
    const changed = [...removed, ...modified]
    onSanitization({ applied: true, changed: changed.length > 0, removed_messages: removed.length, modified_messages: modified.length, first_changed_index: changed.length ? Math.min(...changed) : null })
  }
  return output
}

export function mergeOpenaiSystemMessages(messages: readonly JsonObject[], system = ''): JsonObject[] {
  const rows = clone([...messages]), systems = rows.filter(row => row.role === 'system')
  if (system && !(systems.length && plainContent(systems[0]!.content).startsWith(system))) systems.unshift({ role: 'system', content: system })
  if (!systems.length) return rows
  let content: Json
  if (systems.every(row => typeof row.content === 'string')) content = systems.map(row => text(row.content)).join('\n\n---\n\n')
  else {
    const parts: Json[] = []
    systems.forEach((row, index) => { if (index) parts.push({ type: 'text', text: '\n\n---\n\n' }); parts.push(...(Array.isArray(row.content) ? row.content : [{ type: 'text', text: text(row.content) }])) })
    content = parts
  }
  return [{ ...systems[0]!, role: 'system', content }, ...rows.filter(row => row.role !== 'system')]
}

export function plainContent(value: unknown): string {
  return typeof value === 'string' ? value : array(value).map(record).filter(part => ['text', 'input_text', 'output_text'].includes(text(part.type))).map(part => text(part.text)).join('')
}

export function stripCacheControl(value: Json): Json {
  if (Array.isArray(value)) return value.map(stripCacheControl)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, item]) => [key, stripCacheControl(item)]))
  return value
}
function volatile(value: Json): boolean {
  if (Array.isArray(value)) return value.some(volatile)
  if (!value || typeof value !== 'object') return false
  if (value.type === 'image' && record(value.source).type === 'base64' && text(record(value.source).data)) return true
  if (value.type === 'image_url' && text(record(value.image_url).url || value.image_url).startsWith('data:')) return true
  return Object.values(value).some(volatile)
}
function mark(row: JsonObject): void {
  if (typeof row.content === 'string') row.content = [{ type: 'text', text: row.content, cache_control: { type: 'ephemeral' } }]
  else if (Array.isArray(row.content) && row.content.length) row.content[row.content.length - 1] = { ...record(row.content.at(-1)), cache_control: { type: 'ephemeral' } } as JsonObject
}

export function prepareOpenAiCache(history: readonly JsonObject[], policy: ProviderPolicy, config: ProviderConfig, digest: (value: unknown) => string, stableCount: number, previousAnchor?: unknown): { messages: JsonObject[]; anchor: JsonObject | null } {
  const messages = history.map(row => stripCacheControl(row) as JsonObject)
  if (!policy.explicitCache(config)) return { messages, anchor: null }
  const count = Math.max(0, Math.min(stableCount, messages.length))
  let limit = count
  for (let index = 0; index < count; index++) if (volatile(messages[index]!)) { limit = index; break }
  for (let index = 0; index < count && messages[index]!.role === 'system'; index++) mark(messages[index]!)
  if (!limit) return { messages, anchor: null }
  const single = policy.singleHistoryCacheAnchor(config), strategy = single ? 'single' : 'multi', previous = record(previousAnchor)
  const hashes = history.slice(0, limit).map(row => digest(stripCacheControl(row)))
  let baseline = previous.provider === policy.name && previous.api_format === 'openai' && previous.model === config.model && previous.strategy === strategy ? hashes.indexOf(text(previous.baseline_digest)) : -1
  if (baseline < 0) {
    baseline = limit - 1
    for (let index = limit - 2; index >= 0; index--) if (messages[index]!.role === 'user') { baseline = index; break }
  }
  for (const index of new Set(single ? [limit - 1] : [baseline, limit - 1])) if (index >= 0 && index < limit) mark(messages[index]!)
  return { messages, anchor: { provider: policy.name, api_format: 'openai', model: config.model, strategy, baseline_digest: hashes[baseline] ?? '' } }
}

export function projectOpenai(messages: readonly CanonicalMessage[], config: ProviderConfig, policy: ProviderPolicy, options: ProjectionOptions = {}): JsonObject[] {
  const tail = Math.max(0, Math.min(options.dynamicTailSize ?? 0, messages.length)), split = messages.length - tail
  const toolMedia = { image: (config.capability_overrides?.image ?? config.image ?? policy.capabilities(config).image) === true, audio: true, video: true }
  const stable = renderOpenaiHistory(messages.slice(0, split), options, toolMedia), dynamic = renderOpenaiHistory(messages.slice(split), options, toolMedia)
  const reports: HistorySanitization[] = []
  const projected = mergeOpenaiSystemMessages([...sanitizeOpenaiToolHistory(stable, value => reports.push(value)), ...sanitizeOpenaiToolHistory(dynamic, value => reports.push(value))])
  const first = [reports[0]!.first_changed_index, reports[1]!.first_changed_index === null ? null : stable.length + reports[1]!.first_changed_index!].filter((index): index is number => index !== null)
  options.onSanitization?.({ applied: true, changed: reports.some(value => value.changed), removed_messages: reports.reduce((sum, value) => sum + value.removed_messages, 0), modified_messages: reports.reduce((sum, value) => sum + value.modified_messages, 0), first_changed_index: first.length ? Math.min(...first) : null })
  for (const row of projected) for (const call of array(row.tool_calls)) delete record(call).responses_item_id
  return projected
}

type TransformProtocol = 'openai' | 'responses' | 'ollama'
interface WireUnit { indices: number[]; complete: boolean }

function protectedWireRow(row: JsonObject): boolean {
  if (row.role === 'system' || row.role === 'summary') return true
  const content = plainContent(row.content).trim().replace(/^【消息时间】[^\n]*\n【消息正文】\n|^【消息正文】\n/, '')
  return content.includes('<compacted-summary>') || /^(?:\[system-reminder\]|## (?:项目|日历|文件))/.test(content)
}
function toolMediaRow(row: JsonObject): boolean {
  return row.role === 'user' && /^工具返回了以下(?:图片|多模态内容)/.test(plainContent(row.content))
}
function assistantItem(row: JsonObject): boolean {
  return row.type === 'reasoning' || row.type === 'function_call' || row.role === 'assistant'
}
function wireMessage(row: JsonObject): boolean {
  const content = typeof row.content === 'string' ? !!row.content.trim() : array(row.content).some(value => {
    const block = record(value)
    return ['text', 'input_text', 'output_text'].includes(text(block.type)) ? !!text(block.text).trim() : Object.keys(block).length > 0
  })
  return (row.role === 'user' || row.role === 'assistant') && (content || array(row.images).length > 0)
}

/** 已知wire中只有匹配的全部回执才能和调用组成可删除单元；异常孤儿整体保留。 */
function wireUnits(messages: readonly JsonObject[], protocol: TransformProtocol): WireUnit[] {
  const units: WireUnit[] = []
  for (let cursor = 0; cursor < messages.length;) {
    const indices: number[] = [], pending = new Map<string, string>()
    const first = messages[cursor]!
    let complete = true, invalid = false
    if (protocol === 'responses' && assistantItem(first)) {
      while (cursor < messages.length && assistantItem(messages[cursor]!)) {
        const row = messages[cursor]!
        indices.push(cursor++)
        if (row.type === 'function_call') {
          const id = text(row.call_id)
          if (!id || pending.has(id)) invalid = true
          else pending.set(id, text(row.name))
        }
      }
      // 无assistant或工具的独立reasoning不能被当普通正文裁掉。
      complete = indices.some(index => wireMessage(messages[index]!)) || pending.size > 0
    } else {
      indices.push(cursor++)
      if (first.role === 'assistant') for (const value of array(first.tool_calls)) {
        const call = record(value), id = text(call.id)
        if (!id || pending.has(id)) invalid = true
        else pending.set(id, text(record(call.function).name))
      }
      complete = pending.size > 0 || wireMessage(first)
      if (first.role === 'tool' || first.type === 'function_call_output' || first.type && first.type !== 'message') complete = false
    }
    const hasCalls = pending.size > 0
    if (hasCalls) while (cursor < messages.length) {
      const row = messages[cursor]!
      const result = protocol === 'responses' ? row.type === 'function_call_output' : row.role === 'tool'
      if (!result) break
      let id = text(protocol === 'responses' ? row.call_id : row.tool_call_id)
      // Ollama实际wire仅回传tool_name，重复同名调用按已验证的连续回执逐个消费。
      if (!id && protocol === 'ollama') id = [...pending].find(([, name]) => name && name === text(row.tool_name))?.[0] ?? ''
      if (!id || !pending.has(id)) invalid = true
      else pending.delete(id)
      indices.push(cursor++)
    }
    if (hasCalls && !pending.size) while (cursor < messages.length && toolMediaRow(messages[cursor]!)) indices.push(cursor++)
    units.push({ indices, complete: complete && !invalid && pending.size === 0 })
  }
  return units
}

/** 摘要超窗仅变换实际wire副本，不经过Canonical，也不修改签名/回执/工具身份。 */
export function transformOpenaiWireHistory(history: readonly JsonObject[], stage: WireTransformStage, protectedPrefixRows: number, protocol: TransformProtocol = 'openai'): { messages: JsonObject[]; changedMessages: number } {
  if (!Number.isSafeInteger(protectedPrefixRows) || protectedPrefixRows < 0 || protectedPrefixRows > history.length) throw new ProviderError('input_rejected')
  const messages = clone([...history])
  if (stage === 'strip-tool-inputs') {
    let changedMessages = 0
    for (const row of messages) {
      let changed = false
      const clear = (call: Record<string, unknown>) => {
        if (!Object.hasOwn(call, 'arguments')) return
        const value = call.arguments
        const empty = protocol === 'ollama' ? value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0 : value === '{}'
        if (!empty) { call.arguments = protocol === 'ollama' ? {} : '{}'; changed = true }
      }
      if (protocol === 'responses' && row.type === 'function_call') clear(row)
      else if (row.role === 'assistant') for (const call of array(row.tool_calls)) clear(record(record(call).function))
      if (changed) changedMessages++
    }
    return { messages, changedMessages }
  }
  if (stage !== 'trim-oldest-units') throw new ProviderError('input_rejected')
  const units = wireUnits(messages, protocol)
  const removable = units.filter(unit => unit.complete && !unit.indices.some(index => index < protectedPrefixRows || protectedWireRow(messages[index]!)))
  // 末尾是system/reminder或异常孤儿时，也保住之前最新的完整正文/工具组。
  removable.pop()
  const dropped = new Set(removable.slice(0, Math.ceil(removable.length / 2)).flatMap(unit => unit.indices))
  return { messages: messages.filter((_, index) => !dropped.has(index)), changedMessages: dropped.size }
}
