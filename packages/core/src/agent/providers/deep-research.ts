import type { JsonObject, ProviderDriverDependencies, ProviderHttpRequest } from './contracts.js'
import { normalizedApiKey } from './diagnostics.js'
import { record } from './values.js'
import { readSearchResponse } from './search/http.js'

function text(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

function results(items: unknown, count: number): JsonObject[] {
  if (!Array.isArray(items)) return []
  return items.slice(0, count).flatMap(item => {
    const row = record(item)
    const title = text(row.title), url = text(row.url)
    if (!title && !url) return []
    const snippets = Array.isArray(row.snippets) ? row.snippets.map(text).filter((value): value is string => value !== undefined).join('\n') : ''
    const content = text(row.content) || text(row.description) || snippets || null
    return [{ title: title ?? null, url: url ?? null, content }]
  })
}

async function post(
  dependencies: ProviderDriverDependencies, signal: AbortSignal, url: string, label: string,
  headers: Readonly<Record<string, string>>, body: JsonObject, timeoutMs: number,
): Promise<JsonObject> {
  const request: ProviderHttpRequest = { url, method: 'POST', headers, body, timeoutMs }
  const response = await dependencies.transport.request(request, signal)
  return readSearchResponse(response, label, signal)
}

/** BYOK深度研究试呼复用生产 Provider Transport，并按旧Python Provider协议返回统一投影。 */
export async function deepResearchProbe(
  provider: string, rawApiKey: string, query: string, maxResults: number, depth: string,
  dependencies: ProviderDriverDependencies, signal: AbortSignal,
): Promise<JsonObject> {
  const apiKey = normalizedApiKey(rawApiKey)
  if (!apiKey) return { error: '深度研究 API Key 未配置' }
  const count = Number.isFinite(maxResults) ? Math.trunc(maxResults) : 1
  if (provider === 'tavily') {
    const data = await post(dependencies, signal, 'https://api.tavily.com/search', 'Tavily',
      { 'Content-Type': 'application/json' },
      { api_key: apiKey, query, max_results: count, search_depth: depth, include_answer: true }, 60_000)
    return { query, answer: text(data.answer) ?? null, results: results(data.results, count) }
  }
  if (provider === 'you') {
    const effort = depth === 'basic' ? 'lite' : depth === 'advanced' ? 'deep' : 'standard'
    const data = await post(dependencies, signal, 'https://api.you.com/v1/research', 'You.com',
      { 'X-API-Key': apiKey, 'Content-Type': 'application/json' }, { input: query, research_effort: effort }, 90_000)
    const output = record(data.output)
    return { query, answer: text(output.content) ?? null, results: results(output.sources, count) }
  }
  if (provider === 'baidu') {
    const topK = Math.min(Math.max(count || 1, 1), 50)
    const queryText = [...query].slice(0, 72).join('')
    const data = await post(dependencies, signal, 'https://qianfan.baidubce.com/v2/ai_search/web_search', '百度搜索',
      { 'X-Appbuilder-Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      { messages: [{ content: queryText, role: 'user' }], search_source: 'baidu_search_v2',
        resource_type_filter: [{ type: 'web', top_k: topK }] }, 60_000)
    return { query, answer: null, results: results(data.references, topK) }
  }
  return { error: '不支持的深度研究 Provider' }
}
