import { observe } from '../values.js'
import { throwIfCancelled } from '../errors.js'
import type { Json, JsonObject, ProviderConfig, ProviderDriverDependencies, ProviderHttpResponse } from '../contracts.js'
import { ProviderError } from '../errors.js'
import { clone, record, text } from '../values.js'
import { deepseekSearchSchema, glmSearchSchema, minimaxSearchSchema, mimoSearchSchema, ollamaSearchSchema, qwenChatSearchSchema, qwenResponsesSearchSchema } from './search-schemas.js'

export const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024
export const MAX_SEARCH_RESULT_BYTES = 64 * 1024
export const MAX_SEARCH_TEXT_CHARS = 8000
export const MAX_SEARCH_ARRAY_ITEMS = 20
const encoder = new TextEncoder()
const encodedSize = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength
const omit = Symbol('省略')
const links = new Set(['url', 'link', 'img_src', 'image_url', 'site_icon', 'logo_url'])

/** 预算包含键名/JSON结构，URL不能被截成另一个可访问目标。 */
export function limitSearchResult(data: JsonObject): JsonObject {
  let remaining = MAX_SEARCH_RESULT_BYTES - 512, truncated = false
  function copy(value: Json, field = '', depth = 0): Json | typeof omit {
    if (depth > 20 || remaining < 8) { truncated = true; return omit }
    if (Array.isArray(value)) {
      const result: Json[] = []; remaining -= 2
      if (value.length > MAX_SEARCH_ARRAY_ITEMS) truncated = true
      for (const child of value.slice(0, MAX_SEARCH_ARRAY_ITEMS)) { remaining--; const item = copy(child, field, depth + 1); if (item === omit) break; result.push(item) }
      return result
    }
    if (value !== null && typeof value === 'object') {
      const result: JsonObject = Object.create(null) as JsonObject; remaining -= 2
      const keys = Object.keys(value).sort((a, b) => Number(!['base_resp', 'usage'].includes(a)) - Number(!['base_resp', 'usage'].includes(b)))
      for (const key of keys) {
        const overhead = encodedSize(key) + 2
        if (overhead + 8 > remaining) { truncated = true; continue }
        remaining -= overhead
        const copied = copy(value[key]!, key, depth + 1)
        if (copied !== omit) result[key] = copied
      }
      return result
    }
    if (typeof value === 'string') {
      if (links.has(field)) { if (encodedSize(value) > remaining) { truncated = true; return omit } }
      else {
        // Python字符串长度按Unicode字符计，不在代理对中间截断。
        let characters = [...value]
        if (characters.length > MAX_SEARCH_TEXT_CHARS) { characters = characters.slice(0, MAX_SEARCH_TEXT_CHARS); value = characters.join(''); truncated = true }
        if (encodedSize(value) > remaining) {
          truncated = true; let low = 0, high = characters.length
          while (low < high) { const middle = Math.floor((low + high + 1) / 2); if (encodedSize(characters.slice(0, middle).join('')) <= remaining) low = middle; else high = middle - 1 }
          value = characters.slice(0, low).join('')
        }
      }
    }
    const size = encodedSize(value)
    if (size > remaining) { truncated = true; return omit }
    remaining -= size; return value
  }
  const result = copy(data) as JsonObject
  if (truncated) result._gugu_search_limits = { truncated: true, max_result_bytes: MAX_SEARCH_RESULT_BYTES, max_text_chars: MAX_SEARCH_TEXT_CHARS, max_array_items: MAX_SEARCH_ARRAY_ITEMS, note: '结果已按预算截断，不能视为完整检索；需要细节时缩小查询范围。' }
  return result
}

export function officialSearchHost(baseUrl: string | undefined, defaultUrl: string, hosts: readonly string[]): string | null {
  try {
    const url = new URL(baseUrl?.trim() || defaultUrl)
    return url.protocol === 'https:' && hosts.includes(url.hostname) && (!url.port || url.port === '443') && !url.username && !url.password && !url.search && !url.hash ? url.hostname : null
  } catch { return null }
}
interface SearchTarget { readonly url: string; readonly label: string; readonly auth: string; readonly format?: string }
function searchTarget(config: ProviderConfig): SearchTarget | null {
  const provider = (config.provider || '').trim().toLowerCase()
  if (provider === 'minimax') {
    const host = officialSearchHost(config.base_url, 'https://api.minimaxi.com/v1', ['api.minimax.cn', 'api.minimaxi.com', 'api.minimax.io'])
    return host ? { url: `https://${host}/v1/coding_plan/search`, label: 'MiniMax 搜索服务', auth: 'Authorization' } : null
  }
  if (provider === 'qwen') {
    const format = (config.api_format || 'openai').trim().toLowerCase()
    if (!['openai', 'responses'].includes(format)) return null
    try {
      const url = new URL(config.base_url?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1')
      if (url.protocol !== 'https:' || !(url.hostname === 'dashscope.aliyuncs.com' || url.hostname === 'dashscope-intl.aliyuncs.com' || url.hostname.endsWith('.maas.aliyuncs.com')) || url.username || url.password || url.port && url.port !== '443' || url.search || url.hash || !url.pathname.replace(/\/+$/, '').endsWith('/compatible-mode/v1')) return null
      return { url: `https://${url.hostname}${url.pathname.replace(/\/+$/, '')}/${format === 'responses' ? 'responses' : 'chat/completions'}`, format, label: '百炼联网搜索', auth: 'Authorization' }
    } catch { return null }
  }
  if (provider === 'glm') return officialSearchHost(config.base_url, 'https://open.bigmodel.cn/api/paas/v4/web_search', ['open.bigmodel.cn']) ? { url: 'https://open.bigmodel.cn/api/paas/v4/web_search', label: '智谱网络搜索', auth: 'Authorization' } : null
  if (provider === 'deepseek') return officialSearchHost(config.base_url, 'https://api.deepseek.com/v1/tools/search', ['api.deepseek.com']) ? { url: 'https://api.deepseek.com/v1/tools/search', label: 'DeepSeek 联网搜索', auth: 'Authorization' } : null
  if (provider === 'mimo') {
    if (!['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed', 'mimo-v2.5-pro', 'mimo-v2.5'].includes(config.model.trim().toLowerCase())) return null
    return officialSearchHost(config.base_url, 'https://api.xiaomimimo.com/v1/chat/completions', ['api.xiaomimimo.com']) ? { url: 'https://api.xiaomimimo.com/v1/chat/completions', label: 'MiMo 联网搜索', auth: 'api-key' } : null
  }
  if (provider === 'ollama') {
    if (!config.base_url && config.ollama_mode !== 'cloud') return null
    return officialSearchHost(config.base_url, 'https://ollama.com/api/web_search', ['ollama.com']) ? { url: 'https://ollama.com/api/web_search', label: 'Ollama 联网搜索', auth: 'Authorization' } : null
  }
  return null
}
export const supportsProviderSearch = (config: ProviderConfig): boolean => searchTarget(config) !== null
export function providerSearchSchema(config: ProviderConfig): JsonObject {
  const schemas: Record<string, JsonObject> = { minimax: minimaxSearchSchema, glm: glmSearchSchema, deepseek: deepseekSearchSchema, mimo: mimoSearchSchema, ollama: ollamaSearchSchema, qwen: config.api_format === 'responses' ? qwenResponsesSearchSchema : qwenChatSearchSchema }
  return clone(schemas[config.provider || ''] || { type: 'object', properties: {}, additionalProperties: false })
}

export async function readSearchResponse(response: ProviderHttpResponse, label: string, signal: AbortSignal): Promise<JsonObject> {
  const cancelled = () => { void response.cancel(signal.reason) }
  signal.addEventListener('abort', cancelled, { once: true })
  try {
    throwIfCancelled(signal)
    if (response.status !== 200) return { error: `${label}返回 HTTP ${response.status}` }
    const length = response.headers['content-length'] || ''
    const oversized = { error: `${label}响应超过大小限制，请缩小查询范围或减少正文返回` }
    if (/^\d+$/.test(length) && Number(length) > MAX_SEARCH_RESPONSE_BYTES) return oversized
    const chunks: Uint8Array[] = []; let size = 0
    for await (const chunk of response.body) {
      throwIfCancelled(signal); size += chunk.byteLength
      if (size > MAX_SEARCH_RESPONSE_BYTES) return oversized
      chunks.push(chunk)
    }
    throwIfCancelled(signal)
    const bytes = new Uint8Array(size); let at = 0
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength }
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return { error: `${label}返回了无法识别的数据` } }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: `${label}返回了无法识别的数据` }
    if ('error' in value) return { error: `${label}请求未成功，请检查账户权限或模型支持范围` }
    return limitSearchResult(value as JsonObject)
  } finally { signal.removeEventListener('abort', cancelled); await response.cancel() }
}
export interface ProviderSearchDependencies extends ProviderDriverDependencies {
  pause?(milliseconds: number, signal: AbortSignal): Promise<void>
}
async function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfCancelled(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancelled); resolve() }, milliseconds)
    const cancelled = () => { clearTimeout(timer); signal.removeEventListener('abort', cancelled); reject(new ProviderError('cancelled')) }
    signal.addEventListener('abort', cancelled, { once: true })
  })
}

/** 保留原生参数与结果；工具名称、授权及通用Schema校验属于Tools调用方。 */
export async function searchProvider(config: ProviderConfig, args: JsonObject, dependencies: ProviderSearchDependencies, signal: AbortSignal): Promise<JsonObject> {
  throwIfCancelled(signal)
  const target = searchTarget(config)
  if (!target) return { error: config.provider === 'ollama' ? 'Ollama 联网搜索需要官方 Cloud API Key，不能使用本地服务凭据' : '当前模型提供方的 API 地址、格式或模型不支持联网搜索' }
  const key = config.api_key?.trim() || ''
  if (!key || !/^[\x21-\x7e]+$/.test(key)) return { error: `${target.label}缺少有效 API Key` }
  let payload = clone(args)
  if (config.provider === 'minimax') payload = { q: text(args.query) }
  if (config.provider === 'qwen') {
    if (!config.model.trim()) return { error: '当前 Qwen 配置缺少 API Key 或模型名称' }
    payload = target.format === 'responses' ? { ...payload, max_output_tokens: Math.min(typeof args.max_output_tokens === 'number' ? args.max_output_tokens : 1200, 2048), model: config.model, tools: [{ type: 'web_search' }], store: false }
      : { ...payload, max_tokens: 1200, model: config.model, enable_search: true, include_tool_usage: true, search_options: { forced_search: true, ...record(args.search_options) } as JsonObject }
  }
  if (config.provider === 'mimo') payload = { ...payload, max_completion_tokens: Math.min(typeof args.max_completion_tokens === 'number' ? args.max_completion_tokens : 1024, 2048), model: config.model, stream: false, thinking: { type: 'disabled' } }
  for (let attempt = 0; attempt < (config.provider === 'minimax' ? 3 : 1); attempt++) {
    let data: JsonObject
    try {
      const response = await dependencies.transport.request({ url: target.url, method: 'POST', timeoutMs: config.provider === 'minimax' || config.provider === 'glm' ? 30_000 : 60_000,
        headers: { [target.auth]: target.auth === 'Authorization' ? `Bearer ${key}` : key, 'Content-Type': 'application/json' }, body: payload }, signal)
      data = await readSearchResponse(response, target.label, signal)
    } catch (error) {
      throwIfCancelled(signal); observe(() => dependencies.diagnose?.('provider_search_failed', error))
      return { error: `${target.label}地址校验或连接失败` }
    }
    if (data.error || config.provider !== 'minimax') return data
    const code = String(record(data.base_resp).status_code ?? '0')
    if (['0', '', 'None'].includes(code)) return data
    if (code === '1033' && attempt < 2) { await (dependencies.pause || pause)(5000, signal); continue }
    if (code === '1033') return { error: 'MiniMax 搜索服务暂时出现内部错误，重试后仍未成功，请稍后再试' }
    if (['1004', '2049'].includes(code)) return { error: 'MiniMax 搜索未获授权，请检查 API Key 和账户权限' }
    if (['1008', '2056'].includes(code)) return { error: 'MiniMax 账户余额或可用额度不足，请检查账户状态' }
    return { error: `MiniMax 搜索请求未成功（错误码 ${/^\d{1,10}$/.test(code) ? code : 'unknown'}），请检查账户状态或稍后重试` }
  }
  throw new ProviderError('upstream')
}
