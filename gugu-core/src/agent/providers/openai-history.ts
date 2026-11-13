import type { CanonicalMessage, Json } from '../harness/contracts.js'
import { renderCanonicalEvents } from '../harness/history/canonical-history.js'
import type { JsonObject, ProjectionOptions, ProviderConfig, ProviderPolicy } from './contracts.js'
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
export function sanitizeOpenaiToolHistory(messages: readonly JsonObject[]): JsonObject[] {
  const output: JsonObject[] = []
  for (let index = 0; index < messages.length;) {
    const message = clone(messages[index]!), calls = array(message.tool_calls).map(record)
    if (message.role !== 'assistant' || !calls.length) {
      if (message.role !== 'tool') output.push(message)
      index++; continue
    }
    const byId = new Map<string, Record<string, unknown>>()
    for (const call of calls) if (text(call.id) && !byId.has(text(call.id))) byId.set(text(call.id), call)
    const results: JsonObject[] = []; let cursor = index + 1
    while (cursor < messages.length && messages[cursor]!.role === 'tool') results.push(clone(messages[cursor++]!))
    const matched = new Set(results.map(row => text(row.tool_call_id)).filter(id => byId.has(id)))
    if (matched.size) {
      message.tool_calls = [...byId.entries()].filter(([id]) => matched.has(id)).map(([, call]) => call as JsonObject)
      output.push(message)
      const emitted = new Set<string>()
      for (const row of results) { const id = text(row.tool_call_id); if (matched.has(id) && !emitted.has(id)) { output.push(row); emitted.add(id) } }
    } else if ((Array.isArray(message.content) ? message.content.length > 0 : !!message.content) && (typeof message.content !== 'string' || message.content.trim())) { delete message.tool_calls; output.push(message) }
    index = cursor
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
  const projected = mergeOpenaiSystemMessages([...sanitizeOpenaiToolHistory(renderOpenaiHistory(messages.slice(0, split), options, toolMedia)), ...sanitizeOpenaiToolHistory(renderOpenaiHistory(messages.slice(split), options, toolMedia))])
  for (const row of projected) for (const call of array(row.tool_calls)) delete record(call).responses_item_id
  return projected
}
