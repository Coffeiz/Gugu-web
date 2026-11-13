import type { JsonObject, ProviderConfig } from './contracts.js'
import type { ProviderSearchAdapter, ProviderSearchDependencies } from './search/shared.js'
import { deepseekSearch } from './deepseek/search.js'
import { glmSearch } from './glm/search.js'
import { minimaxSearch } from './minimax/search.js'
import { mimoSearch } from './mimo/search.js'
import { ollamaSearch } from './ollama/search.js'
import { qwenSearch } from './qwen/search.js'

const searchAdapters: Readonly<Record<string, ProviderSearchAdapter>> = Object.freeze({
  minimax: minimaxSearch,
  qwen: qwenSearch,
  glm: glmSearch,
  deepseek: deepseekSearch,
  mimo: mimoSearch,
  ollama: ollamaSearch,
})

function adapterForSearch(config: ProviderConfig): ProviderSearchAdapter | undefined {
  return searchAdapters[(config.provider || '').trim().toLowerCase()]
}

/** 只负责选择当前 Provider 的原生搜索适配器；不统一改写各家的参数格式。 */
export const supportsProviderSearch = (config: ProviderConfig): boolean => adapterForSearch(config)?.supports(config) ?? false
export function providerSearchSchema(config: ProviderConfig): JsonObject {
  return adapterForSearch(config)?.schema(config) ?? { type: 'object', properties: {}, additionalProperties: false }
}
export async function searchProvider(config: ProviderConfig, args: JsonObject, dependencies: ProviderSearchDependencies, signal: AbortSignal): Promise<JsonObject> {
  const adapter = adapterForSearch(config)
  if (!adapter) return { error: '当前模型提供方尚未实现联网搜索' }
  return adapter.search(config, args, dependencies, signal)
}

export {
  MAX_SEARCH_ARRAY_ITEMS, MAX_SEARCH_RESPONSE_BYTES, MAX_SEARCH_RESULT_BYTES, MAX_SEARCH_TEXT_CHARS,
  failedProviderSearch, limitSearchResult, officialSearchHost, pauseSearchRetry,
  readSearchResponse, requestProviderSearch,
} from './search/shared.js'
export type { ProviderSearchAdapter, ProviderSearchDependencies, SearchTarget } from './search/shared.js'
