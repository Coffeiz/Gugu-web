import type { CanonicalMessage, Json } from '../../harness/contracts.js'
import { renderCanonicalEvents, toolResultIsError } from '../../harness/history/canonical-history.js'
import type { JsonObject, ProjectionOptions, ProviderConfig, ProviderPolicy, WireTransformStage } from '../contracts.js'
import { ProviderError } from '../errors.js'
import { array, clone, object, record, text } from '../values.js'

const nativeThinking = new Set(['thinking', 'redacted_thinking'])

/** 历史中的旧字符串参数沿用 Python 规则；只在投影副本中转换，不改 Canonical。 */
function historicalInput(value: unknown): JsonObject {
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)) } catch { return {} }
  }
  return object(value)
}

function mediaAllowed(config: ProviderConfig, policy: ProviderPolicy, kind: 'image' | 'audio' | 'video'): boolean {
  return (config.capability_overrides?.[kind] ?? config[kind] ?? policy.capabilities(config)[kind]) === true
}

function contentBlocks(message: CanonicalMessage, config: ProviderConfig, policy: ProviderPolicy, options: ProjectionOptions): JsonObject[] {
  const values = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : array(message.content)
  const result: JsonObject[] = []
  for (const value of values) {
    const block = record(value), type = text(block.type)
    if (type === 'reasoning_content' || nativeThinking.has(type) && !options.preserveNativeThinking) continue
    if (type === 'tool_call' || type === 'tool_use') {
      const id = text(block.id || block.tool_call_id || block.tool_use_id)
      if (id) result.push({ type: 'tool_use', id, name: text(block.name), input: historicalInput(block.arguments ?? block.input) })
    } else if (type === 'tool_result') {
      const id = text(block.tool_use_id || block.tool_call_id)
      if (!id) continue
      const content = clone(block.content ?? '') as Json
      result.push({ type: 'tool_result', tool_use_id: id, content, ...(block.is_error === true || toolResultIsError(content) ? { is_error: true } : {}) })
    } else if (type === 'text') {
      if (text(block.text)) result.push({ type: 'text', text: text(block.text), ...(block.cache_control ? { cache_control: clone(block.cache_control) as Json } : {}) })
    } else if (type === 'image' || type === 'image_url' || type === 'input_image') {
      if (!mediaAllowed(config, policy, 'image')) throw new ProviderError('unsupported')
      if (type === 'image') result.push(object(block))
      else {
        const url = text(record(block.image_url).url || block.image_url || block.url)
        const inline = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url)
        if (inline) result.push({ type: 'image', source: { type: 'base64', media_type: inline[1]!, data: inline[2]! } })
        else if (/^https?:\/\//.test(url)) result.push({ type: 'image', source: { type: 'url', url } })
        else throw new ProviderError('input_rejected')
      }
    } else if (['audio', 'input_audio', 'video', 'video_url'].includes(type)) {
      if (!mediaAllowed(config, policy, type.includes('video') ? 'video' : 'audio')) throw new ProviderError('unsupported')
      result.push(object(block))
    } else if (nativeThinking.has(type) || type === 'document') {
      result.push(object(block))
    } else if (['quote', 'attachment_ref', 'transcript', 'attachment_text', 'interaction_request', 'interaction_result'].includes(type)) {
      const visible = text(block.text || block.title)
      if (visible) result.push({ type: 'text', text: visible })
    } else if (type) {
      // 未识别的块不能伪装成受支持的上游多模态格式。
      throw new ProviderError('unsupported')
    }
  }
  return result
}

function ids(message: JsonObject | undefined, kind: 'tool_use' | 'tool_result'): Set<string> {
  return new Set(array(message?.content).flatMap(value => {
    const block = record(value)
    return block.type === kind && text(kind === 'tool_use' ? block.id : block.tool_use_id)
      ? [text(kind === 'tool_use' ? block.id : block.tool_use_id)] : []
  }))
}

/** 按相邻位置配对，不能用全局 id 放过重用 id 的孤立结果；不合并消息边界。 */
export function sanitizeAnthropicHistory(history: readonly JsonObject[]): JsonObject[] {
  const source = clone([...history]), output: JsonObject[] = []
  const matchedCalls = new Map<number, Set<string>>(), matchedResults = new Map<number, Set<string>>()
  source.forEach((message, index) => {
    if (message.role !== 'assistant') return
    const pending = ids(message, 'tool_use'), accepted = new Set<string>()
    for (let cursor = index + 1; pending.size && source[cursor]?.role === 'user'; cursor++) {
      const matched = new Set([...ids(source[cursor], 'tool_result')].filter(id => pending.has(id)))
      if (!matched.size) break
      matchedResults.set(cursor, matched)
      for (const id of matched) { pending.delete(id); accepted.add(id) }
    }
    matchedCalls.set(index, accepted)
  })
  source.forEach((message, index) => {
    if (!Array.isArray(message.content)) { output.push(message); return }
    const blocks = message.content.filter(value => {
      const block = record(value)
      if (block.type === 'reasoning_content') return false
      if (block.type === 'tool_use') return message.role === 'assistant' && matchedCalls.get(index)?.has(text(block.id))
      if (block.type === 'tool_result') return message.role === 'user' && matchedResults.get(index)?.has(text(block.tool_use_id))
      return true
    })
    if (blocks.length) output.push({ ...message, content: blocks })
  })
  return output
}

export function projectAnthropicHistory(messages: readonly CanonicalMessage[], config: ProviderConfig, policy: ProviderPolicy, options: ProjectionOptions = {}): JsonObject[] {
  const rendered = renderCanonicalEvents(messages), output: JsonObject[] = []
  for (const message of rendered) {
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    if (message.role === 'tool' && typeof message.content === 'string' && text(message.tool_call_id)) {
      output.push({ role, content: [{ type: 'tool_result', tool_use_id: text(message.tool_call_id), content: message.content, ...(toolResultIsError(message.content) ? { is_error: true } : {}) }] })
      continue
    }
    const content = contentBlocks(message, config, policy, options)
    if (content.length) output.push({ role, content })
  }
  return sanitizeAnthropicHistory(output)
}

/** 原生wire的完整工具单元；不经Canonical重投影，异常配对必须明确失败。 */
function anthropicWireUnits(messages: readonly JsonObject[]): number[][] {
  const blockIds = (message: JsonObject, kind: 'tool_use' | 'tool_result'): string[] => array(message.content).flatMap(value => {
    const block = record(value)
    if (block.type !== kind) return []
    const id = text(kind === 'tool_use' ? block.id : block.tool_use_id)
    if (!id) throw new ProviderError('protocol')
    return [id]
  })
  const units: number[][] = []
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!, calls = blockIds(message, 'tool_use')
    if (blockIds(message, 'tool_result').length || calls.length && message.role !== 'assistant' || new Set(calls).size !== calls.length)
      throw new ProviderError('protocol')
    const unit = [index++], pending = new Set(calls)
    while (pending.size) {
      const next = messages[index]
      if (!next || next.role !== 'user' || blockIds(next, 'tool_use').length) throw new ProviderError('protocol')
      const results = blockIds(next, 'tool_result')
      if (!results.length || new Set(results).size !== results.length || results.some(id => !pending.has(id))) throw new ProviderError('protocol')
      for (const id of results) pending.delete(id)
      unit.push(index++)
    }
    units.push(unit)
  }
  return units
}

function protectedAnthropicRow(message: JsonObject): boolean {
  if (message.role === 'system' || message.role === 'summary') return true
  const texts = typeof message.content === 'string' ? [message.content] : array(message.content).flatMap(value => {
    const block = record(value)
    return block.type === 'text' ? [text(block.text)] : block.type === 'tool_result' && typeof block.content === 'string' ? [block.content] : []
  })
  return texts.some(value => {
    const plain = value.trim().replace(/^【消息时间】[^\n]*\n【消息正文】\n|^【消息正文】\n/, '')
    return plain.includes('<compacted-summary>') || ['[system-reminder]', '## 项目', '## 日历', '## 文件'].some(marker => plain.startsWith(marker))
  })
}

/** 摘要超窗恢复仅变换原生wire副本；签名、块顺序及工具结果不得被重建。 */
export function transformAnthropicWireHistory(history: readonly JsonObject[], stage: WireTransformStage, protectedPrefixRows: number): {
  messages: JsonObject[]
  changedMessages: number
} {
  if (!Number.isSafeInteger(protectedPrefixRows) || protectedPrefixRows < 0 || protectedPrefixRows > history.length
    || !['strip-tool-inputs', 'trim-oldest-units'].includes(stage)) throw new ProviderError('input_rejected')
  const messages = clone([...history]), units = anthropicWireUnits(messages)
  if (stage === 'strip-tool-inputs') {
    let changedMessages = 0
    for (const message of messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
      let changed = false
      for (const value of message.content) {
        const block = record(value)
        if (block.type === 'tool_use' && block.input && typeof block.input === 'object' && !Array.isArray(block.input) && Object.keys(block.input).length) {
          block.input = {}
          changed = true
        }
      }
      if (changed) changedMessages++
    }
    return { messages, changedMessages }
  }
  const visible = (message: JsonObject) => typeof message.content === 'string' ? !!message.content.trim() : array(message.content).some(value => {
    const block = record(value)
    return block.type === 'text' ? !!text(block.text).trim() : ['tool_use', 'tool_result', 'image', 'document'].includes(text(block.type))
  })
  const latest = units.findLast(unit => unit.some(index => !protectedAnthropicRow(messages[index]!) && visible(messages[index]!)))
  const removable = units.filter(unit => unit !== latest && unit.some(index => visible(messages[index]!)) && !unit.some(index => index < protectedPrefixRows || protectedAnthropicRow(messages[index]!)))
  const dropped = new Set(removable.slice(0, Math.ceil(removable.length / 2)).flat())
  return { messages: messages.filter((_, index) => !dropped.has(index)), changedMessages: dropped.size }
}
