import { CoreError, dataContext } from '../contracts/index.js'
import { searchSnippet, type GlobalSearchOperations, type GlobalSearchType } from '../search/index.js'

export const MIND_REFERENCE_SUGGESTION_TYPES: readonly GlobalSearchType[] = Object.freeze([
  'project', 'file', 'folder', 'event', 'canvas_note', 'skill', 'mcp', 'scheduled_task',
])

export interface MindReferenceSuggestionItem {
  type: string
  id: number | string
  label: string
  subtitle: string | null
}

export interface MindReferenceMessage {
  id: number | string
  content: string
  sessionTitle: string | null
}

export interface MindReferenceSuggestionPorts {
  recent(ownerId: string, limit: number): Promise<readonly MindReferenceSuggestionItem[]>
  matchingMessages(ownerId: string, query: string, limit: number): Promise<readonly MindReferenceMessage[]>
  globalSearch: GlobalSearchOperations
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizeId(type: string, id: unknown): number | string | null {
  if (typeof id === 'number' && Number.isFinite(id)) return id
  if (typeof id !== 'string') return null
  return type !== 'mcp' && /^\d+$/.test(id) ? Number(id) : id
}

function searchItems(result: unknown): MindReferenceSuggestionItem[] {
  const allowedTypes = new Set<string>(MIND_REFERENCE_SUGGESTION_TYPES)
  const groups = object(result)?.groups
  if (!Array.isArray(groups)) return []
  const items: MindReferenceSuggestionItem[] = []
  for (const rawGroup of groups) {
    const group = object(rawGroup)
    if (!group || typeof group.type !== 'string' || !allowedTypes.has(group.type) || !Array.isArray(group.items)) continue
    for (const rawItem of group.items) {
      const item = object(rawItem)
      if (!item || typeof item.title !== 'string') continue
      const id = normalizeId(group.type, item.id)
      if (id === null) continue
      items.push({
        type: group.type,
        id,
        label: item.title,
        subtitle: item.subtitle === undefined || item.subtitle === null ? null : String(item.subtitle),
      })
    }
  }
  return items
}

/** 共享引用建议规则；最近候选、站内搜索来源和逐消息查询由可信存储/Host 适配器提供。 */
export function createMindReferenceSuggester(ports: MindReferenceSuggestionPorts) {
  return {
    suggest: async (rawOwnerId: string, rawQuery: string, limit: number): Promise<MindReferenceSuggestionItem[]> => {
      const ownerId = dataContext(rawOwnerId).ownerId
      if (typeof rawQuery !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 20)
        throw new CoreError('invalid_request', '引用建议参数无效')
      const query = rawQuery.trim()
      if (!query) {
        const items = await ports.recent(ownerId, limit)
        return items.slice(0, limit * MIND_REFERENCE_SUGGESTION_TYPES.length)
      }
      const result = await ports.globalSearch.search(ownerId, {
        q: query,
        queries: [query],
        mode: 'OR',
        perType: limit,
        types: [...MIND_REFERENCE_SUGGESTION_TYPES],
      })
      const items = searchItems(result)
      const messages = await ports.matchingMessages(ownerId, query, limit)
      items.push(...messages.map(message => ({
        type: 'conversation',
        id: message.id,
        label: searchSnippet(message.content, [query]),
        subtitle: message.sessionTitle,
      })))
      return items.slice(0, limit * (MIND_REFERENCE_SUGGESTION_TYPES.length + 1))
    },
  }
}
