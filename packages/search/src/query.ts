import { SearchError } from './errors.js'
import { casefoldSearchText } from './unicode.js'

export const GLOBAL_SEARCH_TYPES = [
  'project', 'file', 'folder', 'event', 'client', 'conversation', 'note',
  'canvas_note', 'skill', 'mcp', 'scheduled_task',
] as const
export type GlobalSearchType = typeof GLOBAL_SEARCH_TYPES[number]
export interface GlobalSearchQuery {
  readonly q: string
  readonly queries: readonly string[]
  readonly mode: 'OR' | 'AND'
  readonly perType: number
  readonly types: readonly GlobalSearchType[] | null
}

const stripWhitespace = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u
export function stripSearchWhitespace(value: string): string {
  let start = 0, end = value.length
  while (start < end && stripWhitespace.test(value[start]!)) start++
  while (end > start && stripWhitespace.test(value[end - 1]!)) end--
  return value.slice(start, end)
}
function values(value: unknown): string[] {
  if (value === undefined) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value
  throw new SearchError('invalid_request', '搜索关键词无效')
}
function single(value: unknown, fallback: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw new SearchError('invalid_request', '搜索参数无效')
  return value
}
/** 与旧搜索契约一致：strip、码点截断、Unicode casefold 去重。 */
export function normalizeGlobalSearchQueries(q: string, queries: readonly string[]): string[] {
  const result: string[] = [], seen = new Set<string>()
  for (const value of queries.length > 0 ? queries : [q]) {
    const normalized = [...stripSearchWhitespace(value)].slice(0, 64).join(''), key = casefoldSearchText(normalized)
    if (!normalized || seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
    if (result.length >= 8) break
  }
  return result
}
export function parseGlobalSearchQuery(value: unknown): GlobalSearchQuery {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const q = single(raw.q, ''), queries = normalizeGlobalSearchQueries(q, values(raw.queries))
  const mode = single(raw.mode, 'OR').toUpperCase() === 'AND' ? 'AND' : 'OR'
  let perType = 6
  if (raw.per_type !== undefined) {
    const rawLimit = single(raw.per_type, '').trim()
    if (!/^[+-]?\d+$/.test(rawLimit)) throw new SearchError('invalid_request', 'per_type 必须是 1 到 200 之间的整数')
    perType = Number(rawLimit)
    if (!Number.isSafeInteger(perType) || perType < 1 || perType > 200)
      throw new SearchError('invalid_request', 'per_type 必须是 1 到 200 之间的整数')
  }
  const rawTypes = values(raw.types), known = new Set<string>(GLOBAL_SEARCH_TYPES)
  const types = rawTypes.length === 0 ? null : rawTypes.filter((type): type is GlobalSearchType => known.has(type))
  return { q, queries, mode, perType, types }
}

/** 文件夹匹配优先使用精确路径，其次使用完整名称；同一位置只保留一个结果。 */
export function matchFolderSearchHits<T extends { title: string; path_file: { location: { value: string } } }>(
  query: string, hits: readonly T[],
): T[] {
  const exact = hits.filter(hit => hit.path_file.location.value === query)
  const name = casefoldSearchText(query.normalize('NFC'))
  const candidates = exact.length ? exact : hits.filter(hit => casefoldSearchText(hit.title.normalize('NFC')) === name)
  return [...new Map(candidates.map(hit => [hit.path_file.location.value, hit])).values()]
}
