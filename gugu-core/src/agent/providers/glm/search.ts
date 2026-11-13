import type { ProviderConfig } from '../contracts.js'
import { failedProviderSearch, officialSearchHost, requestProviderSearch, type ProviderSearchAdapter, type SearchTarget } from '../search/shared.js'
import { glmSearchSchema } from './search-schema.js'

function target(config: ProviderConfig): SearchTarget | null {
  return officialSearchHost(config.base_url, 'https://open.bigmodel.cn/api/paas/v4/web_search', ['open.bigmodel.cn'])
    ? { url: 'https://open.bigmodel.cn/api/paas/v4/web_search', label: '智谱网络搜索', key: config.api_key?.trim(), timeoutMs: 30_000 } : null
}

export const glmSearch: ProviderSearchAdapter = {
  supports: config => target(config) !== null,
  schema: () => glmSearchSchema,
  async search(config, args, dependencies, signal) {
    const endpoint = target(config)
    if (!endpoint) return { error: '当前模型提供方的 API 地址、格式或模型不支持联网搜索' }
    if (!endpoint.key || !/^[\x21-\x7e]+$/.test(endpoint.key)) return { error: `${endpoint.label}缺少有效 API Key` }
    try { return await requestProviderSearch(endpoint, args, dependencies, signal) }
    catch (error) { return failedProviderSearch(dependencies, error, endpoint.label) }
  },
}
