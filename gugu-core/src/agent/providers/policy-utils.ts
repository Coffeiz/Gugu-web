import { DEFAULT_CAPABILITIES, DEFAULT_REASONING } from './base.js'
import type { JsonObject, ProviderCapabilities, ProviderConfig, ProviderProtocol, ReasoningCapabilities } from './contracts.js'

export const model = (config: ProviderConfig) => config.model.trim().toLowerCase()
export const protocol = (config: ProviderConfig, fallback: ProviderProtocol = 'openai'): ProviderProtocol => {
  const selected = (config.api_format || '').toLowerCase()
  return selected === 'openai_responses' ? 'responses' : ['openai', 'responses', 'anthropic'].includes(selected) ? selected as ProviderProtocol : fallback
}
export const baseUrl = (config: ProviderConfig, fallback: string) => (config.base_url?.trim() || fallback).replace(/\/+$/, '')
export const modes = ['disabled', 'adaptive'] as const
export const allEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const cap = (values: Partial<ProviderCapabilities>): ProviderCapabilities => ({ ...DEFAULT_CAPABILITIES, ...values })
export const reasoning = (values: Partial<ReasoningCapabilities>): ReasoningCapabilities => ({ ...DEFAULT_REASONING, ...values })

export function effort(config: ProviderConfig, capabilities: ReasoningCapabilities): string | null {
  if (config.thinking === 'disabled') return capabilities.efforts.includes('none') ? 'none' : null
  const value = (config.reasoning_effort || '').toLowerCase()
  return capabilities.efforts.includes(value) ? capabilities.effort_map?.[value] ?? value : null
}
export function effortParams(config: ProviderConfig, capabilities: ReasoningCapabilities, format: ProviderProtocol): JsonObject {
  const selected = effort(config, capabilities)
  if (!selected) return {}
  return format === 'responses' ? { reasoning: { effort: selected } }
    : format === 'anthropic' ? { output_config: { effort: selected } } : { reasoning_effort: selected }
}


/** 只用于独立 JSON 请求；历史追加分支必须由调用方省略该参数。 */
export function providerStructuredOutput(config: ProviderConfig, schema?: JsonObject): JsonObject {
  const name = config.provider || ''
  if (name === 'qwen') {
    if (!model(config).startsWith('qwen3')) return {}
    if (schema) return { response_format: { type: 'json_schema', json_schema: 'name' in schema && 'schema' in schema ? schema : { name: 'gugu_output', schema } } }
  } else if (!['deepseek', 'glm', 'glm-coding', 'mimo', 'ollama'].includes(name)) return {}
  return { response_format: { type: 'json_object' } }
}

/** 兼容旧公共导出名称；新实现统一称为 Provider structured output。 */
export const vendorStructuredOutput = providerStructuredOutput
