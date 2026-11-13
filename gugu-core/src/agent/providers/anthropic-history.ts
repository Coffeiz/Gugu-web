import type { CanonicalMessage, Json } from '../harness/contracts.js'
import { renderCanonicalEvents, toolResultIsError } from '../harness/history/canonical-history.js'
import type { JsonObject, ProjectionOptions, ProviderConfig, ProviderPolicy } from './contracts.js'
import { ProviderError } from './errors.js'
import { array, clone, object, record, text } from './values.js'

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
  source.forEach((message, index) => {
    if (!Array.isArray(message.content)) { output.push(message); return }
    const adjacent = message.role === 'assistant' ? ids(source[index + 1], 'tool_result') : ids(source[index - 1], 'tool_use')
    const blocks = message.content.filter(value => {
      const block = record(value)
      if (block.type === 'reasoning_content') return false
      if (block.type === 'tool_use') return message.role === 'assistant' && source[index + 1]?.role === 'user' && adjacent.has(text(block.id))
      if (block.type === 'tool_result') return message.role === 'user' && source[index - 1]?.role === 'assistant' && adjacent.has(text(block.tool_use_id))
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
