import { createPolicy, genericThinkingParams, DEFAULT_REASONING } from '../base.js'
import type { JsonObject, ProviderConfig } from '../contracts.js'
import { validateLocalBaseUrl } from '../local/policy.js'
import * as shared from '../policy-utils.js'

export function ollamaNativeBaseUrl(config: ProviderConfig): string {
  const configured = config.base_url?.trim().replace(/\/+$/, '')
  if (configured) { const value = configured.replace(/\/v1$/, ''); return validateLocalBaseUrl(value.endsWith('/api') ? value : value + '/api') }
  return config.ollama_mode === 'cloud' ? 'https://ollama.com/api' : 'http://127.0.0.1:11434/api'
}
export const ollamaPolicy = createPolicy('ollama', {
  structuredOutput: (config, schema) => shared.providerStructuredOutput({ ...config, provider: 'ollama' }, schema),
  capabilities: () => shared.cap({ api_format: 'openai', cache_mode: 'none', thinking: true, structured_json: true, tools: true }),
  supportedApiFormats: () => ['openai', 'responses', 'anthropic'],
  protocol: config => (config.ollama_api_mode ?? 'native') === 'native' ? 'ollama' : shared.protocol(config),
  baseUrl: config => (config.ollama_api_mode ?? 'native') === 'native' ? ollamaNativeBaseUrl(config)
    : validateLocalBaseUrl(shared.baseUrl(config, config.ollama_mode === 'cloud' ? 'https://ollama.com/v1' : 'http://127.0.0.1:11434/v1')),
  reasoningCapabilities: (config, format) => format === 'ollama' || format === 'openai' && config.ollama_api_mode === 'openai' ? shared.reasoning({ modes: shared.modes, efforts: ['low', 'medium', 'high', 'max'] }) : DEFAULT_REASONING,
  parameters: (config, format): JsonObject => {
    const generic = genericThinkingParams(config, format)
    if (Object.keys(generic).length) return generic
    if (format !== 'openai' || config.ollama_api_mode !== 'openai') return {}
    const value = config.thinking ?? 'disabled'
    if (!shared.modes.includes(value as typeof shared.modes[number])) return {}
    return { reasoning_effort: value !== 'adaptive' ? 'none' : ['low', 'medium', 'high', 'max'].includes(config.reasoning_effort || '') ? config.reasoning_effort! : 'medium' }
  },
})
