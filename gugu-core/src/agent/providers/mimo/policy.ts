import { createPolicy, DEFAULT_REASONING, configuredResponsesInput } from '../base.js'
import type { JsonObject, ProviderConfig, ProviderProtocol, ReasoningCapabilities } from '../contracts.js'
import * as shared from '../policy-utils.js'

export const mimoPolicy = createPolicy('mimo', {
  structuredOutput: (config, schema) => shared.providerStructuredOutput({ ...config, provider: 'mimo' }, schema),
  capabilities: () => shared.cap({ api_format: 'openai', cache_mode: 'none', thinking: true, structured_json: true, tools: true, audio: true, video: true }),
  supportedApiFormats: () => ['openai', 'responses', 'anthropic'], protocol: config => shared.protocol(config),
  baseUrl: config => shared.baseUrl(config, shared.protocol(config) === 'anthropic' ? 'https://api.xiaomimimo.com/anthropic' : 'https://api.xiaomimimo.com/v1'),
  headers: config => ({ 'api-key': config.api_key || '' }),
  responsesInputCapabilities: config => configuredResponsesInput(config, ['mp3', 'wav', 'flac', 'm4a', 'ogg'], true),
  reasoningCapabilities: () => shared.reasoning({ modes: shared.modes }),
  parameters: (config, format): JsonObject => {
    const value = config.thinking ?? 'disabled'
    if (format === 'responses') return { reasoning: { effort: value === 'disabled' ? 'none' : 'medium' } }
    return shared.modes.includes(value as typeof shared.modes[number]) ? { thinking: { type: value === 'adaptive' ? 'enabled' : 'disabled' } } : {}
  },
})
