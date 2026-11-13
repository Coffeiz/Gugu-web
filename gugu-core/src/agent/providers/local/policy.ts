import { createPolicy, genericThinkingParams } from '../base.js'
import type { JsonObject, ProviderConfig, ProviderProtocol } from '../contracts.js'
import { ProviderError } from '../errors.js'
import * as shared from '../policy-utils.js'

export function validateLocalBaseUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new ProviderError('input_rejected') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) throw new ProviderError('input_rejected')
  return value.replace(/\/+$/, '')
}
export const localPolicy = createPolicy('local', {
  capabilities: () => shared.cap({ api_format: 'openai', cache_mode: 'none', tools: false }),
  supportedApiFormats: () => ['openai', 'responses', 'anthropic'], protocol: config => shared.protocol(config),
  baseUrl: config => validateLocalBaseUrl(shared.baseUrl(config, config.local_runtime === 'llama.cpp' ? 'http://127.0.0.1:8080/v1' : 'http://127.0.0.1:8000/v1')),
  parameters: (config, format): JsonObject => ({ ...genericThinkingParams(config, format), ...(format === 'openai' && config.local_runtime === 'llama.cpp' ? { cache_prompt: true } : {}) }),
})
