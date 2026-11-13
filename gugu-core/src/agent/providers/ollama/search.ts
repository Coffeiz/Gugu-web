import type { ProviderConfig } from '../contracts.js'
import { failedProviderSearch, officialSearchHost, requestProviderSearch, type ProviderSearchAdapter, type SearchTarget } from '../search/shared.js'
import { ollamaSearchSchema } from './search-schema.js'

function target(config: ProviderConfig): SearchTarget | null {
  if (!config.base_url && config.ollama_mode !== 'cloud') return null
  return officialSearchHost(config.base_url, 'https://ollama.com/api/web_search', ['ollama.com'])
    ? { url: 'https://ollama.com/api/web_search', label: 'Ollama 联网搜索', key: config.api_key?.trim() } : null
}

export const ollamaSearch: ProviderSearchAdapter = {
  supports: config => target(config) !== null,
  schema: () => ollamaSearchSchema,
  async search(config, args, dependencies, signal) {
    const endpoint = target(config)
    if (!endpoint) return { error: 'Ollama 联网搜索需要官方 Cloud API Key，不能使用本地服务凭据' }
    if (!endpoint.key || !/^[\x21-\x7e]+$/.test(endpoint.key)) return { error: `${endpoint.label}缺少有效 API Key` }
    try { return await requestProviderSearch(endpoint, args, dependencies, signal) }
    catch (error) { return failedProviderSearch(dependencies, error, endpoint.label) }
  },
}
