import { ProviderError, throwIfCancelled } from '../errors.js'
import { record, text } from '../values.js'
import type { JsonObject, ProviderConfig } from '../contracts.js'
import { failedProviderSearch, officialSearchHost, pauseSearchRetry, requestProviderSearch, type ProviderSearchAdapter, type SearchTarget } from '../search/shared.js'
import { minimaxSearchSchema } from './search-schema.js'

function target(config: ProviderConfig): SearchTarget | null {
  const host = officialSearchHost(config.base_url, 'https://api.minimaxi.com/v1', ['api.minimax.cn', 'api.minimaxi.com', 'api.minimax.io'])
  return host ? { url: `https://${host}/v1/coding_plan/search`, label: 'MiniMax 搜索服务', key: config.api_key?.trim(), timeoutMs: 30_000 } : null
}

export const minimaxSearch: ProviderSearchAdapter = {
  supports: config => target(config) !== null,
  schema: () => minimaxSearchSchema,
  async search(config, args, dependencies, signal) {
    throwIfCancelled(signal)
    const endpoint = target(config)
    if (!endpoint) return { error: '当前模型提供方的 API 地址、格式或模型不支持联网搜索' }
    if (!endpoint.key || !/^[\x21-\x7e]+$/.test(endpoint.key)) return { error: `${endpoint.label}缺少有效 API Key` }
    const payload = { q: text(args.query) }
    for (let attempt = 0; attempt < 3; attempt++) {
      let data: JsonObject
      try { data = await requestProviderSearch(endpoint, payload, dependencies, signal) }
      catch (error) { throwIfCancelled(signal); return failedProviderSearch(dependencies, error, endpoint.label) }
      if (data.error) return data
      const code = String(record(data.base_resp).status_code ?? '0')
      if (['0', '', 'None'].includes(code)) return data
      if (code === '1033' && attempt < 2) { await (dependencies.pause || pauseSearchRetry)(5000, signal); continue }
      if (code === '1033') return { error: 'MiniMax 搜索服务暂时出现内部错误，重试后仍未成功，请稍后再试' }
      if (['1004', '2049'].includes(code)) return { error: 'MiniMax 搜索未获授权，请检查 API Key 和账户权限' }
      if (['1008', '2056'].includes(code)) return { error: 'MiniMax 账户余额或可用额度不足，请检查账户状态' }
      return { error: `MiniMax 搜索请求未成功（错误码 ${/^\d{1,10}$/.test(code) ? code : 'unknown'}），请检查账户状态或稍后重试` }
    }
    throw new ProviderError('upstream')
  },
}
