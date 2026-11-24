import { CoreError } from '../contracts/index.js'
import { strip } from '../shared/values.js'
import { GLOBAL_SEARCH_TYPES } from './query.js'
import type { GlobalSearchQuery, GlobalSearchType } from './query.js'
import { casefoldSearchText, lowerSearchText } from './unicode.js'

export const GLOBAL_SEARCH_ORDER: readonly GlobalSearchType[] = [
  'project', 'file', 'folder', 'event', 'client', 'skill', 'mcp', 'scheduled_task', 'note', 'canvas_note', 'conversation',
]
export interface GlobalSearchSource {
  readonly type: GlobalSearchType
  readonly label: string
  search(ownerId: string, query: GlobalSearchQuery, signal?: AbortSignal): Promise<readonly Record<string, unknown>[]>
}
export interface GlobalSearchOperations {
  readonly availableTypes: readonly GlobalSearchType[]
  readonly missingTypes: readonly GlobalSearchType[]
  search(ownerId: string, query: GlobalSearchQuery, options?: { signal?: AbortSignal }): Promise<unknown>
}
export class GlobalSearchUnavailableError extends CoreError {
  readonly missingTypes: readonly GlobalSearchType[]
  constructor(types: readonly GlobalSearchType[]) {
    super('conflict', `当前平台未提供搜索来源：${types.join(', ')}`)
    this.name = 'GlobalSearchUnavailableError'
    this.missingTypes = Object.freeze([...types])
  }
}
function snapshot(query: GlobalSearchQuery): GlobalSearchQuery {
  const known = new Set<string>(GLOBAL_SEARCH_TYPES)
  if (!query || typeof query.q !== 'string' || !Array.isArray(query.queries) || query.queries.length > 8
    || query.queries.some(term => typeof term !== 'string' || [...term].length < 1 || [...term].length > 64)
    || !['AND', 'OR'].includes(query.mode) || !Number.isSafeInteger(query.perType) || query.perType < 1 || query.perType > 200
    || (query.types !== null && (!Array.isArray(query.types) || query.types.some(type => !known.has(type)))))
    throw new CoreError('invalid_request', '搜索参数无效')
  return Object.freeze({ ...query, queries: Object.freeze([...query.queries]),
    types: query.types === null ? null : Object.freeze([...query.types]) })
}
/** 来源与身份由可信Host装配；缺少的领域后端不能被当作“没有命中”。 */
export function createGlobalSearchOperations(sources: readonly GlobalSearchSource[]): GlobalSearchOperations {
  const registered = new Map<GlobalSearchType, GlobalSearchSource>()
  for (const source of sources) {
    if (!GLOBAL_SEARCH_TYPES.includes(source.type) || registered.has(source.type) || typeof source.search !== 'function'
      || typeof source.label !== 'string' || !source.label)
      throw new CoreError('invalid_request', '搜索来源无效或重复')
    registered.set(source.type, Object.freeze({ type: source.type, label: source.label, search: source.search.bind(source) }))
  }
  if (registered.size === 0) throw new CoreError('conflict', '当前平台未装配搜索后端')
  const ordered = GLOBAL_SEARCH_ORDER.flatMap(type => registered.has(type) ? [registered.get(type)!] : [])
  const missingTypes = Object.freeze(GLOBAL_SEARCH_TYPES.filter(type => !registered.has(type)))
  return {
    availableTypes: Object.freeze(ordered.map(source => source.type)),
    missingTypes,
    async search(ownerId, input, options = {}) {
      const signal = options.signal
      signal?.throwIfAborted()
      // Host传入的是已验证的身份标识；后端负责该标识的存储编码，不从查询字段读取owner。
      if (typeof ownerId !== 'string' || !ownerId) throw new CoreError('invalid_request', '用户 ID 无效')
      const query = snapshot(input), wanted = query.types === null ? null : new Set(query.types)
      for (const type of wanted ?? []) if (!registered.has(type)) throw new CoreError('conflict', '当前平台未提供所请求的搜索来源')
      const browseFiles = wanted && wanted.size > 0 && [...wanted].every(type => type === 'file' || type === 'folder')
      if (!query.queries.length && !browseFiles) return { query: strip(query.q), queries: [], mode: query.mode, total: 0, groups: [] }
      if (wanted === null && missingTypes.length) throw new GlobalSearchUnavailableError(missingTypes)
      const groups: Array<{ type: GlobalSearchType; label: string; items: readonly Record<string, unknown>[] }> = []
      for (const source of ordered) {
        if (wanted && !wanted.has(source.type)) continue
        signal?.throwIfAborted()
        const items = await source.search(ownerId, query, signal).finally(() => signal?.throwIfAborted())
        if (items.length) groups.push({ type: source.type, label: source.label, items })
      }
      return { query: strip(query.q) || query.queries.join(' '), queries: query.queries, mode: query.mode,
        total: groups.reduce((sum, group) => sum + group.items.length, 0), groups }
    },
  }
}

/** 不让孤立代理码元匹配到另一个Unicode字符的一半。返回UTF16偏移，供调用方换算码点。 */
function codepointMatchOffset(text: string, word: string): number {
  const splitsPair = (offset: number) => offset > 0 && offset < text.length
    && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
    && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff
  let offset = text.indexOf(word)
  while (offset >= 0) {
    if (!splitsPair(offset) && !splitsPair(offset + word.length)) return offset
    offset = text.indexOf(word, offset + 1)
  }
  return -1
}

export function searchSnippet(text: string, queries: readonly string[]): string {
  if (!text) return ''
  const points = [...text], folded = casefoldSearchText(text)
  // Python先casefold选词，再用lower定位；fold命中但lower未命中时仍返回前60码点。
  const query = queries.find(value => codepointMatchOffset(folded, casefoldSearchText(value)) >= 0) ?? queries[0]
  if (query === undefined) return strip(points.slice(0, 60).join(''))
  const low = lowerSearchText(text), offset = codepointMatchOffset(low, lowerSearchText(query))
  if (offset < 0) return strip(points.slice(0, 60).join(''))
  const index = [...low.slice(0, offset)].length
  const start = Math.max(0, index - 24), end = Math.min(points.length, index + [...query].length + 24)
  return `${start > 0 ? '…' : ''}${strip(points.slice(start, end).join('')).replace(/\n/g, ' ')}${end < points.length ? '…' : ''}`
}
