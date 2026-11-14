import type { ProviderConfig } from '../contracts.js'
import { failedProviderSearch, requestProviderSearch, type ProviderSearchAdapter, type SearchTarget } from '../search/shared.js'
import { qwenChatSearchSchema } from './chat-search-schema.js'
import { qwenResponsesSearchSchema } from './responses-search-schema.js'

function target(config: ProviderConfig): SearchTarget | null {
  const format = (config.api_format || 'openai').trim().toLowerCase()
  if (!['openai', 'responses'].includes(format)) return null
  try {
    const url = new URL(config.base_url?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1')
    if (url.protocol !== 'https:' || !(url.hostname === 'dashscope.aliyuncs.com' || url.hostname === 'dashscope-intl.aliyuncs.com' || url.hostname.endsWith('.maas.aliyuncs.com')) || url.username || url.password || url.port && url.port !== '443' || url.search || url.hash || !url.pathname.replace(/\/+$/, '').endsWith('/compatible-mode/v1')) return null
    return { url: `https://${url.hostname}${url.pathname.replace(/\/+$/, '')}/${format === 'responses' ? 'responses' : 'chat/completions'}`, format, label: '百炼联网搜索', key: config.api_key?.trim(), timeoutMs: 60_000 }
  } catch { return null }
}

export const qwenSearch: ProviderSearchAdapter = {
  supports: config => target(config) !== null,
  schema: config => (config.api_format || 'openai').trim().toLowerCase() === 'responses' ? qwenResponsesSearchSchema : qwenChatSearchSchema,
  async search(config, args, dependencies, signal) {
    const endpoint = target(config)
    if (!endpoint) return { error: '当前模型提供方的 API 地址、格式或模型不支持联网搜索' }
    if (!endpoint.key || !config.model.trim()) return { error: '当前 Qwen 配置缺少 API Key 或模型名称' }
    const payload = endpoint.format === 'responses'
      ? { ...args, max_output_tokens: Math.min(typeof args.max_output_tokens === 'number' ? args.max_output_tokens : 1200, 2048), model: config.model, tools: [{ type: 'web_search' }], store: false }
      : { ...args, max_tokens: 1200, model: config.model, enable_search: true, include_tool_usage: true, search_options: { forced_search: true, ...(args.search_options && typeof args.search_options === 'object' ? args.search_options : {}) } }
    try { return await requestProviderSearch(endpoint, payload, dependencies, signal) }
    catch (error) { return failedProviderSearch(dependencies, error, endpoint.label) }
  },
}
