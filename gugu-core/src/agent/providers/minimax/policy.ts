import { createPolicy, DEFAULT_REASONING, configuredResponsesInput } from '../base.js'
import type { JsonObject, ProviderConfig, ProviderProtocol, ReasoningCapabilities } from '../contracts.js'
import { minimaxMediaLimits } from './media.js'
import * as shared from '../policy-utils.js'

function minimaxReasoning(config: ProviderConfig, format: ProviderProtocol): ReasoningCapabilities {
  const value = shared.model(config)
  if (value.startsWith('minimax-m3.1-flash')) return shared.reasoning({ modes: ['adaptive'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] })
  if (!/^(minimax-m3|minimax-m2)/.test(value)) return DEFAULT_REASONING
  if (format === 'responses') return shared.reasoning({ modes: value.startsWith('minimax-m3') ? shared.modes : ['adaptive'] })
  if (format === 'openai' && value.startsWith('minimax-m3')) return shared.reasoning({ modes: shared.modes, supports_adaptive_thinking: !value.startsWith('minimax-m3.1') })
  return shared.reasoning({ modes: ['adaptive'] })
}
export const minimaxPolicy = createPolicy('minimax', {
  capabilities: config => shared.cap({ api_format: 'anthropic', cache_mode: /^(minimax-m2|minimax-m3)/.test(shared.model(config)) ? 'active' : 'none', thinking: /^(minimax-m2|minimax-m3)/.test(shared.model(config)), tools: true, image: shared.model(config).startsWith('minimax-m3'), video: shared.model(config).includes('m3') }),
  supportedApiFormats: () => ['anthropic', 'openai', 'responses'], protocol: config => shared.protocol(config, 'anthropic'),
  baseUrl: config => shared.baseUrl(config, shared.protocol(config, 'anthropic') === 'anthropic' ? 'https://api.minimaxi.com/anthropic' : 'https://api.minimax.cn/v1'),
  responsesPromptCacheKey: config => shared.protocol(config, 'anthropic') === 'responses', reasoningCapabilities: minimaxReasoning,
  sanitizerMarkers: () => [']<]minimax', '[e~['], mediaLimits: config => minimaxMediaLimits(config.model),
  responsesInputCapabilities: config => configuredResponsesInput(config),
  parameters: (config, format): JsonObject => {
    const value = config.thinking, caps = minimaxReasoning(config, format), name = shared.model(config)
    if (format === 'anthropic') return shared.effortParams(config, caps, format)
    if (format === 'responses') {
      if (name.startsWith('minimax-m3') && !name.startsWith('minimax-m3.1-flash')) return value === 'adaptive' ? { reasoning: { effort: 'high' } } : {}
      return shared.effortParams(config, caps, format)
    }
    if (!caps.modes.includes(value ?? '')) return {}
    return { thinking: { type: value === 'disabled' ? 'disabled' : 'adaptive' }, ...(value === 'adaptive' ? shared.effortParams(config, caps, format) : {}) }
  },
})
