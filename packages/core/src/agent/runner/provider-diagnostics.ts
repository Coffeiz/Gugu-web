import { AgentRunError } from '../models.js'

export const numeric = ['input', 'context_input', 'output', 'cache_read', 'cache_write', 'output_token_budget'] as const

export const tags = ['run_id', 'round_id'] as const

export const reasons = {
  finish_reason: new Set(['stop', 'end_turn', 'tool_calls', 'tool_use', 'length', 'max_tokens', 'incomplete', 'failed', 'content_filter']),
  incomplete_reason: new Set(['max_output_tokens', 'content_filter', 'unknown']),
}

/** 诊断只保留用量、固定原因和不含内容的关联标识，不复制prompt/response或任意额外字段。 */
export function projectProviderDiagnostic(input: unknown): Readonly<Record<string, string | number | null>> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new AgentRunError('invalid_state', '模型轮次诊断无效')
  const data = input as Record<string, unknown>
  const result: Record<string, string | number | null> = {}
  for (const name of numeric) {
    const value = data[name]
    if (value === undefined)
      continue
    if (value === null)
      result[name] = null
    else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      result[name] = value
    else
      throw new AgentRunError('invalid_state', '模型轮次用量无效')
  }
  for (const name of tags) {
    const value = data[name]
    if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value))
      result[name] = value
  }
  for (const name of ['finish_reason', 'incomplete_reason'] as const) {
    const value = data[name]
    if (value === null)
      result[name] = null
    else if (typeof value === 'string')
      result[name] = reasons[name].has(value) ? value : 'unknown'
  }
  return Object.freeze(result)
}
