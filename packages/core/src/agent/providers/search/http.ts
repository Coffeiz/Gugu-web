import { observe } from '../values.js'
import { throwIfCancelled } from '../errors.js'
import type { JsonObject, ProviderConfig, ProviderDriverDependencies, ProviderHttpResponse } from '../contracts.js'
import { ProviderError } from '../errors.js'
import { limitSearchResult, MAX_SEARCH_RESPONSE_BYTES } from './limits.js'

export function officialSearchHost(baseUrl: string | undefined, defaultUrl: string, hosts: readonly string[]): string | null {
  try {
    const url = new URL(baseUrl?.trim() || defaultUrl)
    return url.protocol === 'https:' && hosts.includes(url.hostname) && (!url.port || url.port === '443') && !url.username && !url.password && !url.search && !url.hash ? url.hostname : null
  } catch { return null }
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
export interface SearchTarget { readonly url: string; readonly label: string; readonly key?: string; readonly auth?: string; readonly format?: string; readonly timeoutMs?: number }
export interface ProviderSearchAdapter {
  supports(config: ProviderConfig): boolean
  schema(config: ProviderConfig): JsonObject
  search(config: ProviderConfig, args: JsonObject, dependencies: ProviderSearchDependencies, signal: AbortSignal): Promise<JsonObject>
}

/** 共用 HTTP 传输与响应预算；目标地址、字段和重试规则由 Provider 自己决定。 */
export async function requestProviderSearch(target: SearchTarget, payload: JsonObject, dependencies: ProviderSearchDependencies, signal: AbortSignal): Promise<JsonObject> {
  const auth = target.auth || 'Authorization'
  const response = await dependencies.transport.request({
    url: target.url, method: 'POST', timeoutMs: target.timeoutMs ?? 60_000,
    headers: { [auth]: auth === 'Authorization' ? `Bearer ${target.key || ''}` : target.key || '', 'Content-Type': 'application/json' },
    body: payload,
  }, signal)
  return readSearchResponse(response, target.label, signal)
}

export function failedProviderSearch(dependencies: ProviderSearchDependencies, error: unknown, label: string): JsonObject {
  observe(() => dependencies.diagnose?.('provider_search_failed', error))
  return { error: `${label}地址校验或连接失败` }
}

export async function pauseSearchRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfCancelled(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancelled); resolve() }, milliseconds)
    const cancelled = () => { clearTimeout(timer); signal.removeEventListener('abort', cancelled); reject(new ProviderError('cancelled')) }
    signal.addEventListener('abort', cancelled, { once: true })
  })
}
