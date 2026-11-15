import { CoreError } from '../contracts/index.js'
import { strip } from '../shared/values.js'
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
function values(value: unknown): string[] {
  if (value === undefined) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value
  throw new CoreError('invalid_request', '搜索关键词无效')
}
function single(value: unknown, fallback: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw new CoreError('invalid_request', '搜索参数无效')
  return value
}
/** 沿用Python的strip→码点截断→casefold去重顺序；不在此实现romaji索引。 */
export function normalizeGlobalSearchQueries(q: string, queries: readonly string[]): string[] {
  const result: string[] = [], seen = new Set<string>()
  for (const value of queries.length > 0 ? queries : [q]) {
    const normalized = [...strip(value)].slice(0, 64).join(''), key = casefoldSearchText(normalized)
    if (!normalized || seen.has(key)) continue
    seen.add(key); result.push(normalized)
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
    if (!/^[+-]?\d+$/.test(rawLimit)) throw new CoreError('invalid_request', 'per_type 必须是 1 到 200 之间的整数')
    perType = Number(rawLimit)
    if (!Number.isSafeInteger(perType) || perType < 1 || perType > 200)
      throw new CoreError('invalid_request', 'per_type 必须是 1 到 200 之间的整数')
  }
  const rawTypes = values(raw.types), known = new Set<string>(GLOBAL_SEARCH_TYPES)
  const types = rawTypes.length === 0 ? null : rawTypes.filter((type): type is GlobalSearchType => known.has(type))
  return { q, queries, mode, perType, types }
}
