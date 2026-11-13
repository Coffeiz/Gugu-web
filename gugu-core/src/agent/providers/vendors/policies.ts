import { createPolicy, DEFAULT_CAPABILITIES, DEFAULT_REASONING, configuredResponsesInput, genericThinkingParams } from '../base.js'
import type { JsonObject, ProviderCapabilities, ProviderConfig, ProviderPolicy, ProviderProtocol, ReasoningCapabilities } from '../contracts.js'
import { ProviderError } from '../errors.js'
import { minimaxMediaLimits } from './media.js'

const model = (config: ProviderConfig) => config.model.trim().toLowerCase()
const protocol = (config: ProviderConfig, fallback: ProviderProtocol = 'openai'): ProviderProtocol => {
  const selected = (config.api_format || '').toLowerCase()
  return selected === 'openai_responses' ? 'responses' : ['openai', 'responses', 'anthropic'].includes(selected) ? selected as ProviderProtocol : fallback
}
const baseUrl = (config: ProviderConfig, fallback: string) => (config.base_url?.trim() || fallback).replace(/\/+$/, '')
const modes = ['disabled', 'adaptive'] as const
const allEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const cap = (values: Partial<ProviderCapabilities>): ProviderCapabilities => ({ ...DEFAULT_CAPABILITIES, ...values })
const reasoning = (values: Partial<ReasoningCapabilities>): ReasoningCapabilities => ({ ...DEFAULT_REASONING, ...values })

function effort(config: ProviderConfig, capabilities: ReasoningCapabilities): string | null {
  if (config.thinking === 'disabled') return capabilities.efforts.includes('none') ? 'none' : null
  const value = (config.reasoning_effort || '').toLowerCase()
  return capabilities.efforts.includes(value) ? capabilities.effort_map?.[value] ?? value : null
}
function effortParams(config: ProviderConfig, capabilities: ReasoningCapabilities, format: ProviderProtocol): JsonObject {
  const selected = effort(config, capabilities)
  if (!selected) return {}
  return format === 'responses' ? { reasoning: { effort: selected } }
    : format === 'anthropic' ? { output_config: { effort: selected } } : { reasoning_effort: selected }
}

const deepseekReasoning = (config: ProviderConfig) => /^(deepseek-flash|deepseek-v4-pro|deepseek-v4-flash)/.test(model(config))
function deepseekReasoningCapabilities(config: ProviderConfig, format: ProviderProtocol): ReasoningCapabilities {
  if (!deepseekReasoning(config)) return DEFAULT_REASONING
  return reasoning({ modes, efforts: [...(format === 'responses' ? ['none'] : []), 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], effort_map: { minimal: 'low', medium: 'high', xhigh: 'high' } })
}
export const deepseekPolicy = createPolicy('deepseek', {
  structuredOutput: (config, schema) => vendorStructuredOutput({ ...config, provider: 'deepseek' }, schema),
  capabilities: config => cap({ api_format: 'openai', cache_mode: 'active', thinking: deepseekReasoning(config), structured_json: true, tools: true, image: ['deepseek-flash', 'deepseek-v4-flash-vision-exp'].includes(model(config)) }),
  supportedApiFormats: () => ['openai', 'responses', 'anthropic'],
  protocol: config => protocol(config),
  baseUrl: config => baseUrl(config, protocol(config) === 'anthropic' ? 'https://api.deepseek.com/anthropic' : 'https://api.deepseek.com'),
  explicitCache: () => false,
  reasoningCapabilities: deepseekReasoningCapabilities,
  parameters: (config, format): JsonObject => {
    if (!deepseekReasoning(config)) return {}
    const value = config.thinking ?? 'disabled'
    if (format === 'responses') return value === 'disabled' ? { reasoning: { effort: 'none' } } : effortParams(config, deepseekReasoningCapabilities(config, format), format)
    if (!modes.includes(value as typeof modes[number])) return {}
    if (format === 'anthropic') return value === 'disabled' ? { reasoning: { effort: 'none' } }
      : { thinking: { type: 'enabled' }, ...effortParams(config, deepseekReasoningCapabilities(config, format), format) }
    return { thinking: { type: value === 'adaptive' ? 'enabled' : 'disabled' }, ...(value === 'adaptive' ? effortParams(config, deepseekReasoningCapabilities(config, format), format) : {}) }
  },
})

const glm53 = (config: ProviderConfig) => model(config).startsWith('glm-5.3')
const glmThinking = (config: ProviderConfig) => /^(glm-4\.5|glm-4\.6|glm-4\.7|glm-5)/.test(model(config))
function glmReasoning(config: ProviderConfig, format: ProviderProtocol): ReasoningCapabilities {
  if (glm53(config)) return format === 'responses' ? reasoning({ modes, efforts: allEfforts, effort_map: { minimal: 'none', low: 'high', medium: 'high', xhigh: 'max' } }) : DEFAULT_REASONING
  return format === 'openai' && glmThinking(config) ? reasoning({ modes }) : DEFAULT_REASONING
}
function glmBase(config: ProviderConfig, coding: boolean): string {
  const format = protocol(config)
  return baseUrl(config, format === 'responses' ? 'https://open.bigmodel.cn/api/v1' : format === 'anthropic'
    ? 'https://open.bigmodel.cn/api/anthropic' : coding ? 'https://open.bigmodel.cn/api/coding/paas/v4' : 'https://open.bigmodel.cn/api/paas/v4')
}
const glmOverrides: Partial<ProviderPolicy> = {
  structuredOutput: (config, schema) => vendorStructuredOutput({ ...config, provider: 'glm' }, schema),
  capabilities: config => cap({ api_format: 'openai', cache_mode: 'none', thinking: glmThinking(config), structured_json: true, tools: true, image: /^(glm-4v|glm-4\.1v|glm-5v)/.test(model(config)) }),
  supportedApiFormats: () => ['openai', 'responses', 'anthropic'], protocol: config => protocol(config),
  baseUrl: config => glmBase(config, false),
  reasoningCapabilities: glmReasoning,
  responsesStore: config => protocol(config) === 'responses' ? false : undefined,
  parameters: (config, format): JsonObject => {
    if (format === 'responses') return effortParams(config, glmReasoning(config, format), format)
    if (format !== 'openai' || glm53(config) || !glmThinking(config)) return {}
    return { thinking: { type: (config.thinking ?? 'disabled') === 'adaptive' ? 'enabled' : 'disabled' } }
  },
}
export const glmPolicy = createPolicy('glm', glmOverrides)
export const glmCodingPolicy = createPolicy('glm-coding', { ...glmOverrides,
  baseUrl: config => glmBase(config, true), capabilities: config => ({ ...glmPolicy.capabilities(config), image: false }),
})

const qwenAnthropicModels = ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.7-flash', 'qwen3.6-max', 'qwen3.6-plus', 'qwen3.6-flash', 'qwen3.5-plus', 'qwen3.5-flash', 'qwen3-max', 'qwen3-coder-next', 'qwen3-coder-plus', 'qwen3-coder-flash', 'qwen3-vl-plus', 'qwen3-vl-flash', 'qwen-vl-max', 'qwen-vl-plus', 'qwen-plus', 'qwen-flash', 'qwen-turbo', 'qwen3.6-27b', 'qwen3.5-397b-a17b', 'qwen3.5-122b-a10b', 'qwen3.5-27b', 'qwen3.5-35b-a3b', 'qwen3.8-2.4t-a95b', 'qwen3.8-27b']
function qwenReasoning(config: ProviderConfig, format: ProviderProtocol): ReasoningCapabilities {
  const value = model(config)
  if (format === 'anthropic' && !/^(qwen3\.8-max|qwen3\.8-flash)/.test(value)) return DEFAULT_REASONING
  if (!value.startsWith('qwen3')) return DEFAULT_REASONING
  return value.startsWith('qwen3.8') ? reasoning({ modes, efforts: allEfforts, effort_map: { minimal: 'low', high: 'xhigh', max: 'xhigh' } }) : reasoning({ modes })
}
export const qwenPolicy = createPolicy('qwen', {
  structuredOutput: (config, schema) => vendorStructuredOutput({ ...config, provider: 'qwen' }, schema),
  capabilities: config => cap({ api_format: 'openai', cache_mode: 'active', thinking: model(config).startsWith('qwen3'), structured_json: model(config).startsWith('qwen3'), structured_schema: model(config).startsWith('qwen3'), tools: true }),
  supportedApiFormats: config => qwenAnthropicModels.some(prefix => model(config) === prefix || model(config).startsWith(prefix + '-')) ? ['openai', 'responses', 'anthropic'] : ['openai', 'responses'],
  protocol: config => protocol(config),
  baseUrl: config => baseUrl(config, protocol(config) === 'anthropic' ? 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/apps/anthropic' : 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
  responsesStore: config => protocol(config) === 'responses' ? false : undefined,
  explicitCache: () => true, singleHistoryCacheAnchor: () => true,
  reasoningCapabilities: qwenReasoning,
  parameters: (config, format): JsonObject => {
    const value = config.thinking ?? 'disabled', caps = qwenReasoning(config, format)
    if (!caps.modes.includes(value)) return {}
    if (format === 'responses') return value === 'disabled' ? { reasoning: { effort: 'none' } } : effortParams(config, caps, format)
    if (format === 'anthropic') return { thinking: { type: value === 'disabled' ? 'disabled' : 'enabled' }, ...(value === 'disabled' ? {} : effortParams(config, caps, format)) }
    if (value === 'disabled' || config.reasoning_effort?.toLowerCase() === 'none') return { enable_thinking: false }
    const selected = effort(config, caps)
    return { preserve_thinking: true, ...(selected && selected !== 'none' ? { reasoning_effort: selected } : {}) }
  },
})

function minimaxReasoning(config: ProviderConfig, format: ProviderProtocol): ReasoningCapabilities {
  const value = model(config)
  if (value.startsWith('minimax-m3.1-flash')) return reasoning({ modes: ['adaptive'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] })
  if (!/^(minimax-m3|minimax-m2)/.test(value)) return DEFAULT_REASONING
  if (format === 'responses') return reasoning({ modes: value.startsWith('minimax-m3') ? modes : ['adaptive'] })
  if (format === 'openai' && value.startsWith('minimax-m3')) return reasoning({ modes, supports_adaptive_thinking: !value.startsWith('minimax-m3.1') })
  return reasoning({ modes: ['adaptive'] })
}
export const minimaxPolicy = createPolicy('minimax', {
  capabilities: config => cap({ api_format: 'anthropic', cache_mode: /^(minimax-m2|minimax-m3)/.test(model(config)) ? 'active' : 'none', thinking: /^(minimax-m2|minimax-m3)/.test(model(config)), tools: true, image: model(config).startsWith('minimax-m3'), video: model(config).includes('m3') }),
  supportedApiFormats: () => ['anthropic', 'openai', 'responses'], protocol: config => protocol(config, 'anthropic'),
  baseUrl: config => baseUrl(config, protocol(config, 'anthropic') === 'anthropic' ? 'https://api.minimaxi.com/anthropic' : 'https://api.minimax.cn/v1'),
  responsesPromptCacheKey: config => protocol(config, 'anthropic') === 'responses', reasoningCapabilities: minimaxReasoning,
  sanitizerMarkers: () => [']<]minimax', '[e~['], mediaLimits: config => minimaxMediaLimits(config.model),
  responsesInputCapabilities: config => configuredResponsesInput(config),
  parameters: (config, format): JsonObject => {
    const value = config.thinking, caps = minimaxReasoning(config, format), name = model(config)
    if (format === 'anthropic') return effortParams(config, caps, format)
    if (format === 'responses') {
      if (name.startsWith('minimax-m3') && !name.startsWith('minimax-m3.1-flash')) return value === 'adaptive' ? { reasoning: { effort: 'high' } } : {}
      return effortParams(config, caps, format)
    }
    if (!caps.modes.includes(value ?? '')) return {}
    return { thinking: { type: value === 'disabled' ? 'disabled' : 'adaptive' }, ...(value === 'adaptive' ? effortParams(config, caps, format) : {}) }
  },
})

export const mimoPolicy = createPolicy('mimo', {
  structuredOutput: (config, schema) => vendorStructuredOutput({ ...config, provider: 'mimo' }, schema),
  capabilities: () => cap({ api_format: 'openai', cache_mode: 'none', thinking: true, structured_json: true, tools: true, audio: true, video: true }),
  supportedApiFormats: () => ['openai', 'responses', 'anthropic'], protocol: config => protocol(config),
  baseUrl: config => baseUrl(config, protocol(config) === 'anthropic' ? 'https://api.xiaomimimo.com/anthropic' : 'https://api.xiaomimimo.com/v1'),
  headers: config => ({ 'api-key': config.api_key || '' }),
  responsesInputCapabilities: config => configuredResponsesInput(config, ['mp3', 'wav', 'flac', 'm4a', 'ogg'], true),
  reasoningCapabilities: () => reasoning({ modes }),
  parameters: (config, format): JsonObject => {
    const value = config.thinking ?? 'disabled'
    if (format === 'responses') return { reasoning: { effort: value === 'disabled' ? 'none' : 'medium' } }
    return modes.includes(value as typeof modes[number]) ? { thinking: { type: value === 'adaptive' ? 'enabled' : 'disabled' } } : {}
  },
})

export function validateLocalBaseUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new ProviderError('input_rejected') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) throw new ProviderError('input_rejected')
  return value.replace(/\/+$/, '')
}
export const localPolicy = createPolicy('local', {
  capabilities: () => cap({ api_format: 'openai', cache_mode: 'none', tools: false }),
  supportedApiFormats: () => ['openai', 'responses', 'anthropic'], protocol: config => protocol(config),
  baseUrl: config => validateLocalBaseUrl(baseUrl(config, config.local_runtime === 'llama.cpp' ? 'http://127.0.0.1:8080/v1' : 'http://127.0.0.1:8000/v1')),
  parameters: (config, format): JsonObject => ({ ...genericThinkingParams(config, format), ...(format === 'openai' && config.local_runtime === 'llama.cpp' ? { cache_prompt: true } : {}) }),
})
export function ollamaNativeBaseUrl(config: ProviderConfig): string {
  const configured = config.base_url?.trim().replace(/\/+$/, '')
  if (configured) { const value = configured.replace(/\/v1$/, ''); return validateLocalBaseUrl(value.endsWith('/api') ? value : value + '/api') }
  return config.ollama_mode === 'cloud' ? 'https://ollama.com/api' : 'http://127.0.0.1:11434/api'
}
export const ollamaPolicy = createPolicy('ollama', {
  structuredOutput: (config, schema) => vendorStructuredOutput({ ...config, provider: 'ollama' }, schema),
  capabilities: () => cap({ api_format: 'openai', cache_mode: 'none', thinking: true, structured_json: true, tools: true }),
  supportedApiFormats: () => ['openai', 'responses', 'anthropic'],
  protocol: config => (config.ollama_api_mode ?? 'native') === 'native' ? 'ollama' : protocol(config),
  baseUrl: config => (config.ollama_api_mode ?? 'native') === 'native' ? ollamaNativeBaseUrl(config)
    : validateLocalBaseUrl(baseUrl(config, config.ollama_mode === 'cloud' ? 'https://ollama.com/v1' : 'http://127.0.0.1:11434/v1')),
  reasoningCapabilities: (config, format) => format === 'ollama' || format === 'openai' && config.ollama_api_mode === 'openai' ? reasoning({ modes, efforts: ['low', 'medium', 'high', 'max'] }) : DEFAULT_REASONING,
  parameters: (config, format): JsonObject => {
    const generic = genericThinkingParams(config, format)
    if (Object.keys(generic).length) return generic
    if (format !== 'openai' || config.ollama_api_mode !== 'openai') return {}
    const value = config.thinking ?? 'disabled'
    if (!modes.includes(value as typeof modes[number])) return {}
    return { reasoning_effort: value !== 'adaptive' ? 'none' : ['low', 'medium', 'high', 'max'].includes(config.reasoning_effort || '') ? config.reasoning_effort! : 'medium' }
  },
})

export const vendorPolicies: Readonly<Record<string, ProviderPolicy>> = Object.freeze({
  deepseek: deepseekPolicy, glm: glmPolicy, 'glm-coding': glmCodingPolicy, qwen: qwenPolicy,
  minimax: minimaxPolicy, mimo: mimoPolicy, local: localPolicy, ollama: ollamaPolicy,
})

/** 只用于独立 JSON 请求；历史追加分支必须由调用方省略该参数。 */
export function vendorStructuredOutput(config: ProviderConfig, schema?: JsonObject): JsonObject {
  const name = config.provider || ''
  if (name === 'qwen') {
    if (!model(config).startsWith('qwen3')) return {}
    if (schema) return { response_format: { type: 'json_schema', json_schema: 'name' in schema && 'schema' in schema ? schema : { name: 'gugu_output', schema } } }
  } else if (!['deepseek', 'glm', 'glm-coding', 'mimo', 'ollama'].includes(name)) return {}
  return { response_format: { type: 'json_object' } }
}
