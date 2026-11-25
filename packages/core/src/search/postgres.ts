import type { Pool } from 'pg'
import { searchSnippet, type GlobalSearchQuery, type GlobalSearchSource } from '@gugu/search'
import { SEARCH_SOURCES } from './sources.js'
import type { SearchRow, SearchSource } from './sources.js'

type QueryPool = Pick<Pool, 'query'>

function hitSql(columns: readonly string[]): string {
  const candidate = columns.map((column) => `COALESCE(${column}, '') ILIKE ('%' || term.value || '%')`).join(' OR ')
  return `(SELECT count(*) FROM unnest($2::text[]) AS term(value) WHERE (${candidate}))`
}

function sourceSql(source: SearchSource, mode: GlobalSearchQuery['mode']): string {
  const hits = hitSql(source.searchable)
  const match = mode === 'AND' ? `${hits} = cardinality($2::text[])` : `${hits} > 0`
  const primary = source.primaryRank
    ?? `CASE WHEN lower(${source.title}) = lower($3) THEN 0 WHEN lower(${source.title}) LIKE lower($3) || '%' THEN 1 ELSE 2 END`
  const ownerCheck = source.owner === 'TRUE' ? 'TRUE' : `${source.owner} = $1`
  return `SELECT ${source.alias}.*${source.extraSelect ?? ''}, ${hits} AS search_hits FROM ${source.table}
    WHERE ${ownerCheck} ${source.extraWhere ?? ''} AND ${match}
    ORDER BY search_hits DESC, ${primary}, ${source.orderBy ?? 'updated_at DESC'} LIMIT $4`
}

async function searchSource(
  pool: QueryPool,
  ownerId: string,
  query: GlobalSearchQuery,
  source: SearchSource,
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  signal?.throwIfAborted()
  const result = await pool.query<SearchRow>(sourceSql(source, query.mode), [ownerId, query.queries, query.queries[0], query.perType]).finally(() => signal?.throwIfAborted())
  return result.rows.map(row => source.map(row, query.queries))
}

async function searchConversations(pool: QueryPool, ownerId: string, query: GlobalSearchQuery, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const sessionHits = hitSql(['s.title'])
  const messageHits = hitSql(['m.content'])
  const modeCondition = (hits: string) => query.mode === 'AND'
    ? `${hits} = cardinality($2::text[])`
    : `${hits} > 0`
  const titles = await pool.query<SearchRow>(`
    SELECT s.id, s.title, '对话' AS subtitle, NULL::bigint AS message_id, ${sessionHits} AS search_hits
    FROM conversation_sessions s WHERE s.user_id=$1 AND ${modeCondition(sessionHits)}
    ORDER BY search_hits DESC, CASE WHEN lower(s.title)=lower($3) THEN 0 WHEN lower(s.title) LIKE lower($3)||'%' THEN 1 ELSE 2 END,
      s.updated_at DESC LIMIT $4`, [ownerId, query.queries, query.queries[0], query.perType]).finally(() => signal?.throwIfAborted())
  const messages = await pool.query<SearchRow>(`
    SELECT s.id, s.title, m.id AS message_id, m.content, ${messageHits} AS search_hits
    FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id
    WHERE s.user_id=$1 AND ${modeCondition(messageHits)}
    ORDER BY search_hits DESC, m.created_at DESC LIMIT $3`, [ownerId, query.queries, 8]).finally(() => signal?.throwIfAborted())
  const items = new Map<string, Record<string, unknown>>()
  for (const row of titles.rows) items.set(String(row.id), { id: row.id, title: row.title, subtitle: row.subtitle })
  for (const row of messages.rows) {
    if (!items.has(String(row.id))) items.set(String(row.id), {
      id: row.id, title: row.title, subtitle: searchSnippet(String(row.content ?? ''), query.queries), message_id: row.message_id,
    })
    if (items.size >= query.perType) break
  }
  return [...items.values()].slice(0, query.perType)
}

/** 复用Host既有PG搜索业务；调用方持有连接池，来源不取得或关闭其生命周期。 */
export function createPostgresGlobalSearchSources(pool: QueryPool): GlobalSearchSource[] {
  return [
    ...SEARCH_SOURCES.map(source => ({
      type: source.type,
      label: source.label,
      async search(ownerId: string, query: GlobalSearchQuery, signal?: AbortSignal) {
        signal?.throwIfAborted()
        return searchSource(pool, ownerId, query, source, signal).finally(() => signal?.throwIfAborted())
      },
    })),
    {
      type: 'conversation', label: '对话',
      async search(ownerId, query, signal) {
        signal?.throwIfAborted()
        return searchConversations(pool, ownerId, query, signal).finally(() => signal?.throwIfAborted())
      },
    },
  ]
}
