import { createPolicy, DEFAULT_REASONING } from '../base.js'
import type { JsonObject, ProviderConfig, ProviderProtocol, ReasoningCapabilities } from '../contracts.js'
import * as shared from '../policy-utils.js'

const qwenAnthropicModels = ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.7-flash', 'qwen3.6-max', 'qwen3.6-plus', 'qwen3.6-flash', 'qwen3.5-plus', 'qwen3.5-flash', 'qwen3-max', 'qwen3-coder-next', 'qwen3-coder-plus', 'qwen3-coder-flash', 'qwen3-vl-plus', 'qwen3-vl-flash', 'qwen-vl-max', 'qwen-vl-plus', 'qwen-plus', 'qwen-flash', 'qwen-turbo', 'qwen3.6-27b', 'qwen3.5-397b-a17b', 'qwen3.5-122b-a10b', 'qwen3.5-27b', 'qwen3.5-35b-a3b', 'qwen3.8-2.4t-a95b', 'qwen3.8-27b']
function qwenReasoning(config: ProviderConfig, format: ProviderProtocol): ReasoningCapabilities {
  const value = shared.model(config)
  if (format === 'anthropic' && !/^(qwen3\.8-max|qwen3\.8-flash)/.test(value)) return DEFAULT_REASONING
  if (!value.startsWith('qwen3')) return DEFAULT_REASONING
  return value.startsWith('qwen3.8') ? shared.reasoning({ modes: shared.modes, efforts: shared.allEfforts, effort_map: { minimal: 'low', high: 'xhigh', max: 'xhigh' } }) : shared.reasoning({ modes: shared.modes })
}
export const qwenPolicy = createPolicy('qwen', {
  structuredOutput: (config, schema) => shared.providerStructuredOutput({ ...config, provider: 'qwen' }, schema),
  capabilities: config => shared.cap({ api_format: 'openai', cache_mode: 'active', thinking: shared.model(config).startsWith('qwen3'), structured_json: shared.model(config).startsWith('qwen3'), structured_schema: shared.model(config).startsWith('qwen3'), tools: true }),
  supportedApiFormats: config => qwenAnthropicModels.some(prefix => shared.model(config) === prefix || shared.model(config).startsWith(prefix + '-')) ? ['openai', 'responses', 'anthropic'] : ['openai', 'responses'],
  protocol: config => shared.protocol(config),
  baseUrl: config => shared.baseUrl(config, shared.protocol(config) === 'anthropic' ? 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/apps/anthropic' : 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
  responsesStore: config => shared.protocol(config) === 'responses' ? false : undefined,
  explicitCache: () => true, singleHistoryCacheAnchor: () => true,
  reasoningCapabilities: qwenReasoning,
  parameters: (config, format): JsonObject => {
    const value = config.thinking ?? 'disabled', caps = qwenReasoning(config, format)
    if (!caps.modes.includes(value)) return {}
    if (format === 'responses') return value === 'disabled' ? { reasoning: { effort: 'none' } } : shared.effortParams(config, caps, format)
    if (format === 'anthropic') return { thinking: { type: value === 'disabled' ? 'disabled' : 'enabled' }, ...(value === 'disabled' ? {} : shared.effortParams(config, caps, format)) }
    if (value === 'disabled' || config.reasoning_effort?.toLowerCase() === 'none') return { enable_thinking: false }
    const selected = shared.effort(config, caps)
    return { preserve_thinking: true, ...(selected && selected !== 'none' ? { reasoning_effort: selected } : {}) }
  },
})
