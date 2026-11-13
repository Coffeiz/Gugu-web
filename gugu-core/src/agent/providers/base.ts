import type { JsonObject, ProviderCapabilities, ProviderConfig, ProviderPolicy, ProviderProtocol, ReasoningCapabilities, ResponsesInputCapabilities } from './contracts.js'
import { ProviderError } from './errors.js'
import { DEFAULT_MEDIA_LIMITS } from './media.js'

export const DEFAULT_CAPABILITIES: ProviderCapabilities = Object.freeze({ api_format: 'openai', cache_mode: 'none', thinking: false, structured_json: false, structured_schema: false, tools: true, parallel_tools: false, image: false, audio: false, video: false })
export const DEFAULT_REASONING: ReasoningCapabilities = Object.freeze({ modes: [], efforts: [], supports_adaptive_thinking: false })

export function normalizeBaseUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new ProviderError('input_rejected') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || url.search)
    throw new ProviderError('input_rejected')
  return url.toString().replace(/\/+$/, '')
}

export function configuredResponsesInput(config: ProviderConfig, audioFormats: readonly string[] = [], supportsVideo = false): ResponsesInputCapabilities {
  const enabled = (key: 'image' | 'audio' | 'video') => (config.capability_overrides?.[key] ?? config[key]) === true
  return { image: enabled('image'), audio_formats: enabled('audio') ? [...audioFormats] : [], video: supportsVideo && enabled('video') }
}

export function genericThinkingToggleSupported(config: ProviderConfig, protocol: ProviderProtocol): boolean {
  const provider = (config.provider ?? '').toLowerCase()
  let hostname = ''
  try { hostname = new URL(config.base_url ?? '').hostname.toLowerCase() } catch { /* 未配置地址按官方默认能力处理。 */ }
  if (provider === 'local') return ['openai', 'responses', 'anthropic'].includes(protocol)
  if (provider === 'ollama') return (config.ollama_api_mode ?? 'native') !== 'native' && ['openai', 'responses', 'anthropic'].includes(protocol)
  if (provider === 'openai') return !!hostname && hostname !== 'api.openai.com' && (protocol === 'openai' || protocol === 'responses')
  if (provider === 'anthropic') return !!hostname && hostname !== 'api.anthropic.com' && protocol === 'anthropic'
  return !['qwen', 'glm', 'glm-coding', 'deepseek', 'minimax', 'mimo'].includes(provider) && protocol === 'openai'
}

export function genericThinkingParams(config: ProviderConfig, protocol: ProviderProtocol): JsonObject {
  if (!genericThinkingToggleSupported(config, protocol) || !['adaptive', 'disabled'].includes(config.thinking ?? '')) return {}
  const enabled = config.thinking === 'adaptive'
  return protocol === 'openai' ? { reasoning_effort: enabled ? 'high' : 'none' }
    : protocol === 'responses' ? { reasoning: { effort: enabled ? 'medium' : 'none' } }
      : { thinking: { type: enabled ? 'adaptive' : 'disabled' } }
}

export function reasoningEffort(config: ProviderConfig, capabilities: ReasoningCapabilities): string | undefined {
  if (config.thinking === 'disabled') return capabilities.efforts.includes('none') ? 'none' : undefined
  const effort = (config.reasoning_effort ?? '').toLowerCase()
  return capabilities.efforts.includes(effort) ? capabilities.effort_map?.[effort] ?? effort : undefined
}

export function createPolicy(name: string, overrides: Partial<ProviderPolicy> = {}): ProviderPolicy {
  const policy: ProviderPolicy = {
    name,
    capabilities: () => ({ ...DEFAULT_CAPABILITIES }),
    supportedApiFormats: config => [policy.capabilities(config).api_format],
    protocol: config => {
      const configured = (config.api_format ?? '').toLowerCase()
      if (['openai', 'responses', 'anthropic', 'openai_responses'].includes(configured)) return configured === 'openai_responses' ? 'responses' : configured as ProviderProtocol
      if (['anthropic', 'minimax'].includes(policy.name)) return 'anthropic'
      const known = ['openai', 'qwen', 'glm', 'glm-coding', 'deepseek', 'mimo', 'ollama', 'local']
      if (known.includes(policy.name) || known.includes((config.provider ?? '').toLowerCase())) return 'openai'
      return (config.base_url ?? '').toLowerCase().includes('anthropic') ? 'anthropic' : 'openai'
    },
    baseUrl: config => normalizeBaseUrl(config.base_url || 'https://api.openai.com/v1'),
    headers: () => ({}),
    reasoningCapabilities: () => DEFAULT_REASONING,
    parameters: (config, protocol): JsonObject => {
      const generic = genericThinkingParams(config, protocol)
      if (Object.keys(generic).length) return generic
      const effort = reasoningEffort(config, policy.reasoningCapabilities(config, protocol))
      if (!effort) return {}
      return protocol === 'responses' ? { reasoning: { effort } } : protocol === 'anthropic' ? { output_config: { effort } } : { reasoning_effort: effort }
    },
    structuredOutput: () => ({}),
    responsesInputCapabilities: config => configuredResponsesInput(config),
    responsesStore: () => undefined,
    responsesPromptCacheKey: () => false,
    explicitCache: () => true,
    singleHistoryCacheAnchor: () => false,
    sanitizerMarkers: () => [],
    mediaLimits: () => ({ ...DEFAULT_MEDIA_LIMITS }),
    ...overrides,
  }
  return policy
}

export function filterReasoningConfig(config: ProviderConfig, policy: ProviderPolicy): ProviderConfig {
  const protocol = policy.protocol(config)
  const generic = genericThinkingToggleSupported(config, protocol)
  const capabilities = generic ? DEFAULT_REASONING : policy.reasoningCapabilities(config, protocol)
  const result = { ...config }
  const thinking = config.thinking
  const effortSupported = capabilities.efforts.includes(config.reasoning_effort ?? '')
  if (generic) {
    if (thinking && !['disabled', 'adaptive'].includes(thinking)) result.thinking = null
    result.reasoning_effort = ''
  } else {
    if (thinking && !capabilities.modes.includes(thinking) && !(thinking === 'adaptive' && effortSupported && !capabilities.modes.length)) result.thinking = null
    if (config.reasoning_effort && (!effortSupported || thinking === 'disabled')) result.reasoning_effort = ''
  }
  return result
}
