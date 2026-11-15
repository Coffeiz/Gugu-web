import type { Json, JsonObject, ProviderDriverDependencies, ProviderHttpRequest } from './contracts.js'
import { normalizedApiKey } from './diagnostics.js'
import { object } from './values.js'
import { readSearchResponse } from './search/http.js'

function preferred(value: Json | undefined, fallback: Json | undefined): Json {
  return value || fallback || null
}

function base64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let encoded = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!, second = bytes[index + 1], third = bytes[index + 2]
    const block = (first << 16) | ((second ?? 0) << 8) | (third ?? 0)
    encoded += alphabet.charAt((block >> 18) & 63) + alphabet.charAt((block >> 12) & 63)
      + (second === undefined ? '=' : alphabet.charAt((block >> 6) & 63))
      + (third === undefined ? '=' : alphabet.charAt(block & 63))
  }
  return encoded
}

/** BYOK 百度相似图探测复用生产 Provider Transport，不跟随重定向并限制响应体积。 */
export async function similarImageProbe(
  rawApiKey: string, image: Uint8Array, count: number,
  dependencies: ProviderDriverDependencies, signal: AbortSignal,
): Promise<JsonObject> {
  let apiKey: string
  try { apiKey = normalizedApiKey(rawApiKey) }
  catch { return { error_code: 'invalid_api_key' } }
  if (!apiKey) return { error_code: 'invalid_api_key' }

  const request: ProviderHttpRequest = {
    url: 'https://qianfan.baidubce.com/v2/tools/image_similar_info',
    method: 'POST', timeoutMs: 30_000,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: { image: base64(image), count },
  }
  let response
  try { response = await dependencies.transport.request(request, signal) }
  catch { return { error_code: 'upstream_error' } }

  if (response.status !== 200) {
    await response.cancel()
    if (response.status === 401 || response.status === 403) return { error_code: 'upstream_auth' }
    if (response.status === 429) return { error_code: 'upstream_rate_limited' }
    if (response.status >= 500) return { error_code: 'upstream_unavailable' }
    return { error_code: 'upstream_error' }
  }

  const data = await readSearchResponse(response, '百度相似图搜索', signal)
  if (data.error) return { error_code: 'upstream_error' }
  const nestedResult = object(data.result)
  const resultData = data.result !== null && typeof data.result === 'object' && !Array.isArray(data.result)
    ? nestedResult : data
  const resData = object(resultData.res_data)
  const rawItems = resData?.res_items
  const items: Json[] = Array.isArray(rawItems) ? rawItems
    : rawItems !== null && typeof rawItems === 'object' ? Object.values(rawItems) : []
  const results: Json[] = items.slice(0, Math.max(0, Math.trunc(count))).flatMap(value => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
    const item = object(value)
    return [{
      title: item.title ?? null,
      site_name: item.site_name ?? null,
      source_url: preferred(item.fromurl, item.result_page),
      image_url: item.objurl ?? null,
      detail_url: preferred(item.detail_page, item.result_page),
      similarity: item.sim_level ?? null,
      width: item.width ?? null,
      height: item.height ?? null,
    }]
  })
  return { results, request_id: data.requestId || resultData.requestId || null, count: results.length }
}
