import { createPolicy, DEFAULT_REASONING } from '../base.js'
import type { ProviderConfig, ProviderProtocol, ReasoningCapabilities } from '../contracts.js'
import * as shared from '../policy-utils.js'

const deepseekReasoning = (config: ProviderConfig) => /^(deepseek-flash|deepseek-v4-pro|deepseek-v4-flash)/.test(shared.model(config))
function deepseekReasoningCapabilities(config: ProviderConfig, format: ProviderProtocol): ReasoningCapabilities {
  if (!deepseekReasoning(config)) return DEFAULT_REASONING
  return shared.reasoning({ modes: shared.modes, efforts: [...(format === 'responses' ? ['none'] : []), 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], effort_map: { minimal: 'low', medium: 'high', xhigh: 'high' } })
}
export const deepseekPolicy = createPolicy('deepseek', {
  structuredOutput: (config, schema) => shared.providerStructuredOutput({ ...config, provider: 'deepseek' }, schema),
  capabilities: config => shared.cap({ api_format: 'openai', cache_mode: 'active', thinking: deepseekReasoning(config), structured_json: true, tools: true, image: ['deepseek-flash', 'deepseek-v4-flash-vision-exp'].includes(shared.model(config)) }),
  supportedApiFormats: () => ['openai', 'responses', 'anthropic'],
  protocol: config => shared.protocol(config),
  baseUrl: config => shared.baseUrl(config, shared.protocol(config) === 'anthropic' ? 'https://api.deepseek.com/anthropic' : 'https://api.deepseek.com'),
  explicitCache: () => false,
  reasoningCapabilities: deepseekReasoningCapabilities,
  parameters: (config, format): JsonObject => {
    if (!deepseekReasoning(config)) return {}
    const value = config.thinking ?? 'disabled'
    if (format === 'responses') return value === 'disabled' ? { reasoning: { effort: 'none' } } : shared.effortParams(config, deepseekReasoningCapabilities(config, format), format)
    if (!shared.modes.includes(value as typeof shared.modes[number])) return {}
    if (format === 'anthropic') return value === 'disabled' ? { reasoning: { effort: 'none' } }
      : { thinking: { type: 'enabled' }, ...shared.effortParams(config, deepseekReasoningCapabilities(config, format), format) }
    return { thinking: { type: value === 'adaptive' ? 'enabled' : 'disabled' }, ...(value === 'adaptive' ? shared.effortParams(config, deepseekReasoningCapabilities(config, format), format) : {}) }
  },
})
