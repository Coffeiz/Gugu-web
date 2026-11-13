import { anthropicDriver, anthropicPolicy } from './anthropic/driver.js'
import { openaiDriver, openaiPolicy } from './openai/driver.js'
import { responsesDriver } from './openai/responses.js'
import { providerPolicies } from './provider-policies.js'
import { ollamaDriver } from './ollama/driver.js'
import type { ProviderConfig, ProviderPolicy, ProviderProtocol, ProtocolDriver } from './contracts.js'
import { filterReasoningConfig, genericThinkingToggleSupported, DEFAULT_REASONING } from './base.js'
import { ProviderError } from './errors.js'

const policies: Readonly<Record<string, ProviderPolicy>> = { ...providerPolicies, openai: openaiPolicy, anthropic: anthropicPolicy }
const drivers: Readonly<Record<ProviderProtocol, ProtocolDriver>> = { openai: openaiDriver, responses: responsesDriver, anthropic: anthropicDriver, ollama: ollamaDriver }
const capabilityKeys = ['thinking', 'structured_json', 'structured_schema', 'tools', 'parallel_tools', 'image', 'audio', 'video']
function capabilityOverrides(config: ProviderConfig) { return Object.fromEntries(Object.entries(config.capability_overrides ?? {}).filter(([key, item]) => capabilityKeys.includes(key) && typeof item === 'boolean')) }

/** 精确配置优先，兼容旧URL推断；只选择协议，网络授权仍由transport独立执行。 */
export function adapterFor(config: ProviderConfig): ProviderPolicy {
  const name = (config.provider ?? '').trim().toLowerCase(), url = (config.base_url ?? '').toLowerCase()
  if (['glm', 'glm-coding'].includes(name) && url.includes('bigmodel.cn') && url.includes('/api/coding/')) return providerPolicies['glm-coding']!
  if (policies[name]) return policies[name]
  if (url.includes('xiaomimimo')) return providerPolicies.mimo!
  if (url.includes('minimaxi.com')) return providerPolicies.minimax!
  if (url.includes('deepseek')) return providerPolicies.deepseek!
  if (url.includes('bigmodel.cn')) return providerPolicies[url.includes('/api/coding/') ? 'glm-coding' : 'glm']!
  if (url.includes('ollama') || url.includes('11434')) return providerPolicies.ollama!
  return openaiPolicy
}

export function providerSelection(config: ProviderConfig): { policy: ProviderPolicy; config: ProviderConfig; driver: ProtocolDriver } {
  config = { ...config, provider: config.provider?.trim().toLowerCase(), api_format: config.api_format?.trim().toLowerCase(), model: config.model.trim() }
  const selected = adapterFor(config)
  const policy: ProviderPolicy = {
    ...selected,
    capabilities: value => ({ ...selected.capabilities(value), ...capabilityOverrides(value) }),
  }
  const filtered = filterReasoningConfig(config, policy), protocol = policy.protocol(filtered)
  if (!drivers[protocol]) throw new ProviderError('unsupported')
  return { policy, config: filtered, driver: drivers[protocol] }
}

export function capabilitySnapshot(config: ProviderConfig) {
  const { policy, config: filtered } = providerSelection(config)
  const protocol = policy.protocol(filtered), supported = policy.supportedApiFormats(filtered)
  const generic = genericThinkingToggleSupported(filtered, protocol)
  const reasoning = generic ? DEFAULT_REASONING : policy.reasoningCapabilities(filtered, protocol)
  const selectable = policy.name === 'ollama' ? ['native', ...supported.filter(item => item !== 'ollama')] : [...supported]
  const urls = Object.fromEntries(selectable.map(format => [format, policy.baseUrl({ ...config, base_url: undefined, api_format: format === 'native' ? undefined : format, ...(policy.name === 'ollama' ? { ollama_api_mode: format === 'native' ? 'native' : 'openai' } : {}) })]))
  return {
    provider: policy.name, model: config.model, default_base_url: policy.baseUrl({ ...config, base_url: undefined }),
    default_base_urls: urls, default_api_format: policy.name === 'ollama' ? 'native' : policy.capabilities(config).api_format,
    selected_api_format: protocol, supported_api_formats: [...supported],
    selectable_api_formats: selectable,
    api_format_source: ['local', 'ollama'].includes(policy.name) ? 'user_selectable' : 'provider_declared',
    reasoning_modes: [...reasoning.modes], reasoning_efforts: [...reasoning.efforts],
    supports_adaptive_thinking: reasoning.supports_adaptive_thinking,
    generic_thinking_toggle_supported: generic,
    ...policy.capabilities(config), overrides: capabilityOverrides(config),
  }
}
