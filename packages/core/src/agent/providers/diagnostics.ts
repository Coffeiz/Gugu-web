import type { ProviderConfig, ProviderDriverDependencies, ProviderHttpRequest } from './contracts.js'
import { providerSelection } from './registry.js'
import { ProviderError } from './errors.js'
import { endpoint, requestJson } from './http.js'

/** 只清理HTTP鉴权token；不可用此规则处理用户正文。 */
export function normalizedApiKey(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || /[^\x20-\x7e]/.test(value.trim())) throw new ProviderError('input_rejected')
  return value.trim()
}

export function providerDiagnosticRequest(config: ProviderConfig, kind: 'models' | 'completion' = 'completion'): ProviderHttpRequest {
  const { policy, config: filtered, driver } = providerSelection(config)
  const key = normalizedApiKey(filtered.api_key) || (policy.name === 'ollama' ? 'ollama' : '')
  const base = policy.baseUrl(filtered), anthropic = driver.protocol === 'anthropic'
  const headers: Record<string, string> = { Accept: 'application/json', ...(anthropic ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) } : key ? { Authorization: `Bearer ${key}` } : {}), ...policy.headers(filtered) }
  if (policy.name === 'mimo') delete headers.Authorization
  let path: string
  let body: ProviderHttpRequest['body']
  if (kind === 'models') path = driver.protocol === 'ollama' ? 'tags' : anthropic && !base.endsWith('/v1') ? 'v1/models' : 'models'
  else if (driver.protocol === 'ollama') { path = 'chat'; body = { model: filtered.model, messages: [{ role: 'user', content: 'hi' }], stream: false, think: false } }
  else if (anthropic) { path = base.endsWith('/v1') ? 'messages' : 'v1/messages'; body = { model: filtered.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] } }
  else if (driver.protocol === 'responses') { path = 'responses'; body = { model: filtered.model, max_output_tokens: 1, input: [{ role: 'user', content: 'hi' }] } }
  else { path = 'chat/completions'; body = { model: filtered.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }], ...policy.parameters(filtered, 'openai', 'standalone') } }
  return { url: endpoint(base, path), method: kind === 'models' ? 'GET' : 'POST', headers, ...(body ? { body } : {}), timeoutMs: filtered.timeout_ms,
    allowLocal: ['local', 'ollama'].includes((filtered.provider ?? '').toLowerCase()) }
}

export async function listProviderModels(config: ProviderConfig, dependencies: ProviderDriverDependencies, signal: AbortSignal): Promise<readonly unknown[]> {
  const response = await requestJson(dependencies, providerDiagnosticRequest(config, 'models'), signal)
  const models = response.data ?? response.models
  if (!Array.isArray(models)) throw new ProviderError('protocol')
  return structuredClone(models)
}
