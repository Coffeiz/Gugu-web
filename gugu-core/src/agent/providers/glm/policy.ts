import { createPolicy, DEFAULT_REASONING } from '../base.js'
import type { JsonObject, ProviderConfig, ProviderPolicy, ProviderProtocol, ReasoningCapabilities } from '../contracts.js'
import * as shared from '../policy-utils.js'

const glm53 = (config: ProviderConfig) => shared.model(config).startsWith('glm-5.3')
const glmThinking = (config: ProviderConfig) => /^(glm-4\.5|glm-4\.6|glm-4\.7|glm-5)/.test(shared.model(config))
function glmReasoning(config: ProviderConfig, format: ProviderProtocol): ReasoningCapabilities {
  if (glm53(config)) return format === 'responses' ? shared.reasoning({ modes: shared.modes, efforts: shared.allEfforts, effort_map: { minimal: 'none', low: 'high', medium: 'high', xhigh: 'max' } }) : DEFAULT_REASONING
  return format === 'openai' && glmThinking(config) ? shared.reasoning({ modes: shared.modes }) : DEFAULT_REASONING
}
function glmBase(config: ProviderConfig, coding: boolean): string {
  const format = shared.protocol(config)
  return shared.baseUrl(config, format === 'responses' ? 'https://open.bigmodel.cn/api/v1' : format === 'anthropic'
    ? 'https://open.bigmodel.cn/api/anthropic' : coding ? 'https://open.bigmodel.cn/api/coding/paas/v4' : 'https://open.bigmodel.cn/api/paas/v4')
}
const glmOverrides: Partial<ProviderPolicy> = {
  structuredOutput: (config, schema) => shared.providerStructuredOutput({ ...config, provider: 'glm' }, schema),
  capabilities: config => shared.cap({ api_format: 'openai', cache_mode: 'none', thinking: glmThinking(config), structured_json: true, tools: true, image: /^(glm-4v|glm-4\.1v|glm-5v)/.test(shared.model(config)) }),
  supportedApiFormats: () => ['openai', 'responses', 'anthropic'], protocol: config => shared.protocol(config),
  baseUrl: config => glmBase(config, false),
  reasoningCapabilities: glmReasoning,
  responsesStore: config => shared.protocol(config) === 'responses' ? false : undefined,
  parameters: (config, format): JsonObject => {
    if (format === 'responses') return shared.effortParams(config, glmReasoning(config, format), format)
    if (format !== 'openai' || glm53(config) || !glmThinking(config)) return {}
    return { thinking: { type: (config.thinking ?? 'disabled') === 'adaptive' ? 'enabled' : 'disabled' } }
  },
}
export const glmPolicy = createPolicy('glm', glmOverrides)
export const glmCodingPolicy = createPolicy('glm-coding', { ...glmOverrides,
  baseUrl: config => glmBase(config, true), capabilities: config => ({ ...glmPolicy.capabilities(config), image: false }),
})
