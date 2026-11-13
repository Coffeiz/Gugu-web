
import type { BudgetResult,CanonicalMessage,Json,ProtectedWindow,ProviderUsage,Usage } from '../contracts.js'
import { HarnessError } from '../contracts.js'
import type { MessageArea } from '../history/canonical-history.js'
import { atomicMessageUnits,blocks,copy,isCompactedSummaryMessage,toolCallIds,toolResultIds } from '../history/canonical-history.js'

export function providerInputTokens(usage: ProviderUsage | null, requestId: string, modelIdentity: string): number | null {
  if (!usage || usage.requestId !== requestId || usage.modelIdentity !== modelIdentity || usage.freshInput == null)
    return null
  const values = [usage.freshInput, usage.cacheRead ?? 0, usage.cacheWrite ?? 0]
  if (values.some(value => !Number.isSafeInteger(value) || value < 0))
    return null
  const total = values.reduce((sum, value) => sum + value, 0)
  return Number.isSafeInteger(total) ? total : null
}

export function shouldCompact(inputTokens: number | null, contextWindow: number): boolean {
  return inputTokens != null && Number.isSafeInteger(inputTokens) && inputTokens >= 0
    && Number.isSafeInteger(contextWindow) && contextWindow > 0 && inputTokens >= contextWindow * 0.85
}

export function isContextOverflowError(error: unknown): boolean {
  const own = (value: unknown, key: string): unknown => value && typeof value === 'object'
    ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined
  // SDK异常body可能有循环、BigInt或访问器；分类不能调用JSON序列化或触发访问器。
  const bodyText = (value: unknown): string => {
    const pending: unknown[] = [value], seen = new Set<unknown>(), text: string[] = []
    for (let visited = 0; pending.length && visited < 256; visited++) {
      const item = pending.pop()
      if (typeof item === 'string') { text.push(item.slice(0, 8192)); continue }
      if (!item || typeof item !== 'object' || seen.has(item)) continue
      seen.add(item)
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item)))
        if ('value' in descriptor) pending.push(descriptor.value)
    }
    return text.join(' ')
  }
  const pending: unknown[] = [error], seen = new Set<unknown>()
  while (pending.length) {
    const current = pending.pop()
    if (!current || typeof current !== 'object' || seen.has(current))
      continue
    seen.add(current)
    pending.push(own(current, 'cause'), own(current, '__cause__'), own(current, '__context__'))
    const text = [own(current, 'message'), own(current, 'code'), own(current, 'type'), own(current, 'param'), bodyText(own(current, 'body'))]
      .filter((value): value is string => typeof value === 'string').join(' ').toLowerCase()
    if (['context_overflow', 'request_too_large', 'context_length_exceeded', 'context_window_exceeded', 'input_too_long', 'prompt_too_long'].some(marker => text.includes(marker)))
      return true
    if (['max_tokens', 'maximum output', 'output token limit'].some(marker => text.includes(marker)))
      continue
    if (['maximum context length', 'context window exceeded', 'context length exceeded', 'context window exceeds limit', 'input token count exceeds', 'prompt is too long', 'input is too long', 'request entity too large', 'request too large'].some(marker => text.includes(marker)))
      return true
    if (String(own(current, 'status_code') ?? own(current, 'status') ?? own(own(current, 'response'), 'status_code')) === '413')
      return true
  }
  return false
}

export function shortenText(value: Json): Json {
  if (typeof value === 'string' && [...value].length > 2048)
    return [...value].slice(0, 2048).join('') + '\n[工具输出因请求超限已截短]'
  if (Array.isArray(value))
    return value.map(block => block && typeof block === 'object' && !Array.isArray(block) && block.type === 'text' && 'text' in block ? { ...block, text: shortenText(block.text!) } : block)
  return value
}

export function shortenResult(message: CanonicalMessage): CanonicalMessage {
  if (message.role === 'tool')
    return { ...message, content: shortenText(message.content) }
  if (!Array.isArray(message.content))
    return message
  return { ...message, content: blocks(message.content).map(block => block.type === 'tool_result' ? { ...block, content: shortenText(block.content ?? '') } : block) }
}

/** 仅在 Provider 已明确拒绝请求后调用一次。平时自动压缩只依据实际 Provider usage。 */
export function enforceProviderOverflow(area: MessageArea, window: ProtectedWindow = {}): BudgetResult {
  const before = area.messages, prefix = area.fixedPrefixSize
  let result: CanonicalMessage[], info: Omit<BudgetResult, 'changed' | 'droppedMessages'> = {}
  const from = window.from != null ? Math.max(0, window.from - prefix) : before.length
  if (window.anchorIndex != null) {
    const anchor = window.anchorIndex - prefix
    if (anchor < 0 || anchor >= before.length || (window.from != null && anchor >= from))
      return { changed: false, droppedMessages: 0 }
    const previousFrom = window.previousFrom != null ? Math.max(0, window.previousFrom - prefix) : anchor
    const previous = previousFrom < anchor ? before.slice(previousFrom, anchor) : []
    const body = [...before.slice(0, previous.length ? previousFrom : anchor), ...before.slice(anchor + 1, from)]
    const summaries = body.filter(isCompactedSummaryMessage)
    const tail = before.slice(from), units = atomicMessageUnits(tail)
    const last = [...units].reverse().find(unit => toolCallIds(tail[unit[0]!]!).size) ?? units.at(-1)
    const offset = last?.[0] ?? tail.length
    const kept = tail.slice(offset).map(message => last && toolCallIds(tail[last[0]!]!).size ? shortenResult(message) : message)
    result = [...summaries, ...previous, before[anchor]!, ...kept]
    info = {
      protectedStartIndex: prefix + summaries.length + previous.length + 1,
      anchorIndex: prefix + summaries.length + previous.length, protectedSourceStartIndex: prefix + from + offset,
      ...(previous.length ? { previousProtectedStartIndex: prefix + summaries.length } : {})
    }
  }
  else {
    const body = before.slice(0, from), tail = before.slice(from)
    const units = atomicMessageUnits(body), kept = units.slice(-10).flat().map(index => body[index]!)
    result = [...kept, ...tail]
  }
  const revision = area.revision
  area.replaceBaseline(copy(result), revision)
  return { changed: area.revision !== revision, droppedMessages: before.length - result.length, ...info }
}

export function dropOrphanToolResults(messages: readonly CanonicalMessage[]): {
  messages: CanonicalMessage[]
  sourceIndexes: number[]
} {
  const available = new Set<string>(), result: CanonicalMessage[] = [], sourceIndexes: number[] = []
  messages.forEach((message, index) => {
    const calls = toolCallIds(message), results = toolResultIds(message)
    if (calls.size) {
      available.clear()
      for (const id of calls)
        available.add(id)
    }
    if (results.size) {
      const valid = new Set([...results].filter(id => available.has(id)))
      const normalized = copy(message)
      if (Array.isArray(normalized.content))
        normalized.content = blocks(normalized.content).filter(block => block.type !== 'tool_result' || valid.has(String(block.tool_call_id || block.tool_use_id)))
      if (!valid.size && (message.role === 'tool' || !Array.isArray(normalized.content) || !normalized.content.length)) {
        available.clear()
        return
      }
      result.push(normalized)
      sourceIndexes.push(index)
      for (const id of valid)
        available.delete(id)
      return
    }
    if (!calls.size)
      available.clear()
    result.push(copy(message))
    sourceIndexes.push(index)
  })
  return { messages: result, sourceIndexes }
}

/** 累计消耗与最近请求占用分开：budget用current，final用累计与峰值。 */
export function mergeUsage(total: Usage, current: Usage): Usage {
  const result: Usage = {
    input: total.input + current.input,
    output: total.output + current.output,
    cacheRead: total.cacheRead + current.cacheRead,
    cacheWrite: total.cacheWrite + current.cacheWrite,
    contextInput: current.contextInput === null ? total.contextInput : Math.max(total.contextInput ?? 0, current.contextInput),
  }
  if (![result.input, result.output, result.cacheRead, result.cacheWrite].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new HarnessError('invalid_state', '累计模型用量无效')
  return Object.freeze(result)
}
