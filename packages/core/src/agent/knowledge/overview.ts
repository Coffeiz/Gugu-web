import { CoreError, dataContext } from '../../contracts/index.js'
import { utc } from '../../data/codec.js'

/** 由可信 Host 提供的只读存储；不得通过用户输入选择根目录。 */
export interface AgentKnowledgeReadStore {
  exists(key: string): Promise<boolean>
  list(prefix: string, cursor: string | null, limit: number): Promise<{ keys: readonly string[]; nextCursor: string | null }>
  read(key: string): Promise<Uint8Array>
}
export interface AgentKnowledgeOverviewItem { title: string; topic: string; description: string }
type Entry = AgentKnowledgeOverviewItem & { id: string; updated: number; owner: string; type: string; active: boolean }
const unavailable = () => new CoreError('storage_error', '知识数据暂不可用')
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const fieldsOnly = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key))
function time(value: unknown): number {
  if (typeof value !== 'string' || !/(Z|[+-]\d\d(?::?\d\d)?)$/i.test(value)) throw new Error('time')
  const normalized = utc(value), match = /\.(\d{6})\+00:00$/.exec(normalized)
  const milliseconds = Date.parse(normalized)
  if (!Number.isFinite(milliseconds)) throw new Error('time')
  return Math.floor(milliseconds / 1000) + Number(match?.[1] ?? 0) / 1_000_000
}
function checkNestedTimes(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) checkNestedTimes(item); return }
  if (!record(value)) return
  for (const [key, item] of Object.entries(value)) {
    if (['created_at', 'updated_at', 'checked_at'].includes(key) && item !== null) time(item)
    else checkNestedTimes(item)
  }
}
function parse(raw: Uint8Array): Entry {
  const text = new TextDecoder('utf-8').decode(raw)
  if (!text.startsWith('---\n')) throw new Error('frontmatter')
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) throw new Error('frontmatter')
  const fields: Record<string, string> = Object.create(null)
  for (const line of text.slice(4, end).split('\n')) {
    const i = line.indexOf(':')
    if (i >= 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim().replaceAll('\\n', '\n').replaceAll('\\\\', '\\')
  }
  if (!Object.hasOwn(fields, 'id')) throw new Error('id')
  const json = (name: string, fallback: unknown) => { try { return JSON.parse(fields[name] ?? '') } catch { return fallback } }
  const scopeValue = json('scope_json', {}), source = json('source_json', {}), history = json('history_json', [])
  const scope = scopeValue === null || scopeValue === false || scopeValue === '' ? {} : scopeValue
  if (!record(scope) || !fieldsOnly(scope, ['type','owner_user_id','platform','bot_id','group_id','scope_id','project_id']) ||
      !record(source) || !fieldsOnly(source, ['type','ref','label','checked_at']) || !Object.hasOwn(source, 'type')) throw new Error('metadata')
  checkNestedTimes(source); checkNestedTimes(history)
  const version = fields.version || '1'
  if (!/^[+-]?\d+$/.test(version.trim())) throw new Error('version')
  time(fields.created_at); const updated = time(fields.updated_at)
  return { id: fields.id!, title: fields.title || '', topic: fields.topic || '', description: fields.description || '',
    updated, owner: typeof scope.owner_user_id === 'string' ? scope.owner_user_id : '',
    type: Object.hasOwn(scope, 'type') ? scope.type === 'owner' ? 'owner' : '' : 'owner', active: (fields.active ?? 'true').toLowerCase() === 'true' }
}

/** 只接受已迁移标记；缺失和存储错误都不能伪装成空知识。 */
export function createAgentKnowledgeOverview(store: AgentKnowledgeReadStore) {
  if (!store || typeof store.exists !== 'function' || typeof store.list !== 'function' || typeof store.read !== 'function') throw new TypeError('知识存储未装配')
  return async (ownerId: string, signal?: AbortSignal): Promise<AgentKnowledgeOverviewItem[]> => {
    signal?.throwIfAborted()
    const owner = dataContext(ownerId).ownerId, base = `${owner}/.agent/knowledge/`, prefix = `${base}entries/`
    try {
      if (!await store.exists(`${base}.timestamps-iso-v1`)) throw unavailable()
      const keys: string[] = [], seen = new Set<string>()
      let cursor: string | null = null
      do {
        signal?.throwIfAborted()
        const page = await store.list(prefix, cursor, 500)
        if (!page || !Array.isArray(page.keys) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) throw unavailable()
        for (const key of page.keys) {
          if (typeof key !== 'string' || !key.startsWith(prefix) || !key.endsWith('.md') || key.slice(prefix.length).split('/').some(part => !part || part === '.' || part === '..') || key.includes('\\')) throw unavailable()
          keys.push(key)
        }
        cursor = page.nextCursor
        if (cursor !== null && (seen.has(cursor) || !cursor)) throw unavailable()
        if (cursor !== null) seen.add(cursor)
      } while (cursor !== null)
      const entries: Entry[] = []
      for (const key of keys) {
        signal?.throwIfAborted()
        const raw = await store.read(key)
        if (!(raw instanceof Uint8Array)) throw unavailable()
        let entry: Entry
        try { entry = parse(raw) } catch { continue }
        if (entry.active && entry.owner === owner && entry.type === 'owner') entries.push(entry)
      }
      signal?.throwIfAborted()
      entries.sort((a, b) => b.updated - a.updated || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      return entries.map(({ title, topic, description }) => ({ title, topic, description }))
    } catch (error) {
      signal?.throwIfAborted()
      throw unavailable()
    }
  }
}
