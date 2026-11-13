import type { ProviderConfig } from '../contracts.js'
import { failedProviderSearch, officialSearchHost, requestProviderSearch, type ProviderSearchAdapter, type SearchTarget } from '../search/shared.js'
import { deepseekSearchSchema } from './search-schema.js'

function target(config: ProviderConfig): SearchTarget | null {
  return officialSearchHost(config.base_url, 'https://api.deepseek.com/v1/tools/search', ['api.deepseek.com'])
    ? { url: 'https://api.deepseek.com/v1/tools/search', label: 'DeepSeek 联网搜索', key: config.api_key?.trim() } : null
}

export const deepseekSearch: ProviderSearchAdapter = {
  supports: config => target(config) !== null,
  schema: () => deepseekSearchSchema,
  async search(config, args, dependencies, signal) {
    const endpoint = target(config)
    if (!endpoint) return { error: '当前模型提供方的 API 地址、格式或模型不支持联网搜索' }
    if (!endpoint.key || !/^[\x21-\x7e]+$/.test(endpoint.key)) return { error: `${endpoint.label}缺少有效 API Key` }
    try { return await requestProviderSearch(endpoint, args, dependencies, signal) }
    catch (error) { return failedProviderSearch(dependencies, error, endpoint.label) }
  },
}
