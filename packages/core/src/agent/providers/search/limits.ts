import type { Json, JsonObject } from '../contracts.js'

export const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024
export const MAX_SEARCH_RESULT_BYTES = 64 * 1024
export const MAX_SEARCH_TEXT_CHARS = 8000
export const MAX_SEARCH_ARRAY_ITEMS = 20
const encoder = new TextEncoder()
const encodedSize = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength
const omit = Symbol('省略')
const links = new Set(['url', 'link', 'img_src', 'image_url', 'site_icon', 'logo_url'])

/** 限制模型可见搜索结果的正文体积，保留 URL 完整性。 */
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
