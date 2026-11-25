import { sql, type Kysely } from 'kysely'
import { CoreError, dataContext } from '../contracts/index.js'
import { integer } from '../data/codec.js'
import { isCanonicalSqliteTime } from '../data/sqlite-time-sql.js'
import { searchSnippet, type GlobalSearchSource } from '@gugu/search'

function resultError(): never { throw new CoreError('storage_error', '搜索结果格式无效') }
function jsonRows(value: unknown): Record<string, unknown>[] {
  if (typeof value !== 'string') return resultError()
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return resultError() }
  if (!Array.isArray(parsed) || parsed.some(row => row === null || typeof row !== 'object' || Array.isArray(row))) return resultError()
  return parsed as Record<string, unknown>[]
}

/** SQLite单语句只读快照；不跨来源保证一致性，也不承诺同步查询执行中可以中断。 */
export function createSqliteConversationSearch<DB>(db: Kysely<DB>): GlobalSearchSource {
  return {
    type: 'conversation', label: '对话',
    async search(rawOwner, query, signal) {
      signal?.throwIfAborted()
      const owner = dataContext(rawOwner).ownerId.replaceAll('-', '')
      const terms = Object.freeze([...query.queries]), mode = query.mode, perType = query.perType
      if (!terms.length) return []
      const titleHits = sql`(${sql.join(terms.map(term => sql`CASE WHEN lower(title) LIKE lower(${'%' + term + '%'}) ESCAPE ${'\\'} THEN 1 ELSE 0 END`), sql` + `)})`
      const messageHits = sql`(${sql.join(terms.map(term => sql`CASE WHEN lower(content) LIKE lower(${'%' + term + '%'}) ESCAPE ${'\\'} THEN 1 ELSE 0 END`), sql` + `)})`
      const match = (hits: typeof titleHits) => mode === 'AND' ? sql`${hits}=${terms.length}` : sql`${hits}>0`
      try {
        const result = await sql<{ invalid_count: unknown; titles: unknown; messages: unknown }>`
          WITH owner_sessions AS MATERIALIZED (
            SELECT id,title,updated_at FROM conversation_sessions WHERE user_id=${owner}
          ), time_values(value) AS (
            SELECT updated_at FROM owner_sessions UNION ALL
            SELECT m.created_at FROM conversation_messages m JOIN owner_sessions s ON s.id=m.session_id
          ), validation AS (
            SELECT COALESCE(SUM(CASE WHEN ${isCanonicalSqliteTime(sql`value`)}
              THEN 0 ELSE 1 END),0) AS invalid_count FROM time_values
          ), ranked_titles AS MATERIALIZED (
            SELECT id,title,${titleHits} AS hits FROM owner_sessions
            WHERE ${match(titleHits)} ORDER BY hits DESC,
              CASE WHEN lower(title)=lower(${terms[0]}) THEN 0 WHEN lower(title) LIKE lower(${terms[0]}) || '%' ESCAPE ${'\\'} THEN 1 ELSE 2 END,
              updated_at DESC LIMIT ${perType}
          ), ranked_messages AS MATERIALIZED (
            SELECT m.id,m.session_id,s.title,m.content,${messageHits} AS hits FROM conversation_messages m
            JOIN owner_sessions s ON s.id=m.session_id
            WHERE ${match(messageHits)} ORDER BY hits DESC,m.created_at DESC LIMIT 8
          )
          SELECT invalid_count,
            CASE WHEN invalid_count=0 THEN (SELECT COALESCE(json_group_array(json_object('id',id,'title',title)),'[]') FROM ranked_titles) ELSE '[]' END AS titles,
            CASE WHEN invalid_count=0 THEN (SELECT COALESCE(json_group_array(json_object('id',id,'session_id',session_id,'title',title,'content',content)),'[]') FROM ranked_messages) ELSE '[]' END AS messages
          FROM validation`.execute(db)
        const row = result.rows[0]
        if (!row) return resultError()
        const invalid = integer(row.invalid_count)
        if (invalid < 0) return resultError()
        if (invalid > 0) throw new CoreError('storage_error', '搜索时间格式无效')
        const titles = jsonRows(row.titles), messages = jsonRows(row.messages)
        if (titles.length > perType || messages.length > 8) return resultError()
        const found = new Map<number, Record<string, unknown>>()
        for (const item of titles) {
          if (typeof item.title !== 'string') return resultError()
          const id = integer(item.id)
          found.set(id, { id, title: item.title, subtitle: '对话' })
        }
        for (const item of messages) {
          if (typeof item.title !== 'string' || typeof item.content !== 'string') return resultError()
          const id = integer(item.session_id)
          if (!found.has(id)) found.set(id, { id, title: item.title, subtitle: searchSnippet(item.content, terms), message_id: integer(item.id) })
          if (found.size >= perType) break
        }
        return [...found.values()].slice(0, perType)
      } finally { signal?.throwIfAborted() }
    },
  }
}
