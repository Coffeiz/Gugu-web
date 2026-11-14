import type { ProviderConfig } from '../contracts.js'
import { failedProviderSearch, officialSearchHost, requestProviderSearch, type ProviderSearchAdapter, type SearchTarget } from '../search/shared.js'
import { mimoSearchSchema } from './search-schema.js'

const supportedModels = new Set(['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed', 'mimo-v2.5-pro', 'mimo-v2.5'])
function target(config: ProviderConfig): SearchTarget | null {
  if (!supportedModels.has(config.model.trim().toLowerCase())) return null
  return officialSearchHost(config.base_url, 'https://api.xiaomimimo.com/v1/chat/completions', ['api.xiaomimimo.com'])
    ? { url: 'https://api.xiaomimimo.com/v1/chat/completions', label: 'MiMo 联网搜索', auth: 'api-key', key: config.api_key?.trim() } : null
}

export const mimoSearch: ProviderSearchAdapter = {
  supports: config => target(config) !== null,
  schema: () => mimoSearchSchema,
  async search(config, args, dependencies, signal) {
    const endpoint = target(config)
    if (!endpoint) return { error: '当前模型提供方的 API 地址、格式或模型不支持联网搜索' }
    if (!endpoint.key || !/^[\x21-\x7e]+$/.test(endpoint.key)) return { error: `${endpoint.label}缺少有效 API Key` }
    const payload = { ...args, max_completion_tokens: Math.min(typeof args.max_completion_tokens === 'number' ? args.max_completion_tokens : 1024, 2048), model: config.model, stream: false, thinking: { type: 'disabled' } }
    try { return await requestProviderSearch(endpoint, payload, dependencies, signal) }
    catch (error) { return failedProviderSearch(dependencies, error, endpoint.label) }
  },
}
