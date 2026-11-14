import type { ProviderConfig, ProviderPolicy } from './contracts.js'
import type { JsonObject } from './contracts.js'
import { stripThinking } from './sanitize.js'

/** 明确null保留Provider默认上限，不把推理预算强加给无限设置。 */
export function outputBudget(config: ProviderConfig, policy: ProviderPolicy, requested: number | null): number | null {
  if (requested === null) return null
  const reasoning = policy.reasoningCapabilities(config, policy.protocol(config))
  return reasoning.modes.length || reasoning.efforts.length ? Math.max(requested, 4096) : requested
}

/** 与旧非聊天入口一致：先去精确思考标签，再容忍代码围栏，仅接受JSON对象。 */
export function parseStructuredJson(text: string): JsonObject {
  let value = stripThinking(text).trim()
  if (value.includes('```')) { value = value.split('```', 3)[1] ?? ''; if (value.startsWith('json')) value = value.slice(4) }
  const first = value.indexOf('{'), last = value.lastIndexOf('}')
  if (first < 0 || last < first) return {}
  try { const parsed: unknown = JSON.parse(value.slice(first, last + 1)); return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {} }
  catch { return {} }
}
