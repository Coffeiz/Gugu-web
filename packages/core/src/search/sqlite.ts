import { sql, type Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'
import type { GlobalSearchSource } from './global-search.js'
import { SEARCH_SOURCES } from './sources.js'

/** 正式 SQLite 已有表直接复用共享来源定义；文件、用户 Skill、MCP 等 Host 专属表仍由 Host 提供。 */
export function createKyselySqliteGlobalSearchSources<DB>(db: Kysely<DB>): GlobalSearchSource[] {
  return SEARCH_SOURCES.filter(source => ['project', 'client', 'event', 'scheduled_task', 'note', 'canvas_note'].includes(source.type)).map(source => ({
    type: source.type,
    label: source.label,
    async search(rawOwner, query, signal) {
      signal?.throwIfAborted()
      const owner = dataContext(rawOwner).ownerId.replaceAll('-', '')
      const terms = Object.freeze([...query.queries])
      if (!terms.length) return []
      const extraWhere = source.type === 'scheduled_task'
        ? sql`AND t.enabled = 1 AND (t.end_at IS NULL OR datetime(t.end_at) > datetime('now'))`
        : source.type === 'note'
          ? sql`AND n.kind = 'note' AND n.deleted_at IS NULL`
          : source.type === 'canvas_note'
            ? sql`AND n.kind = 'canvas_note' AND n.deleted_at IS NULL AND ci.user_id = ${owner}
              AND ci.deleted_at IS NULL AND mm.user_id = ${owner} AND mm.deleted_at IS NULL`
            : sql.raw(source.extraWhere ?? '')
      // SQL结构只来自可信内置metadata；owner、关键词和limit始终绑定参数。
      const hits = sql`(${sql.join(terms.map(term => {
        const fields = source.searchable.map(column => sql`lower(COALESCE(${sql.raw(column)}, '')) LIKE lower(${'%' + term + '%'})`)
        return sql`CASE WHEN (${sql.join(fields, sql` OR `)}) THEN 1 ELSE 0 END`
      }), sql` + `)})`
      const match = query.mode === 'AND' ? sql`${hits} = ${terms.length}` : sql`${hits} > 0`
      const rank = source.type === 'note' || source.type === 'canvas_note'
        ? sql`CASE WHEN lower(COALESCE(${sql.raw(source.title)},'')) = lower(${terms[0]}) THEN 0
          WHEN lower(COALESCE(${sql.raw(source.title)},'')) LIKE lower(${terms[0]}) || '%' THEN 1
          WHEN lower(COALESCE(${sql.raw(source.title)},'')) LIKE '%' || lower(${terms[0]}) || '%' THEN 2 ELSE 3 END`
        : sql`CASE WHEN lower(${sql.raw(source.title)}) = lower(${terms[0]}) THEN 0
          WHEN lower(${sql.raw(source.title)}) LIKE lower(${terms[0]}) || '%' THEN 1 ELSE 2 END`
      let rows: Record<string, unknown>[]
      try {
        const result = await sql<Record<string, unknown>>`SELECT ${sql.raw(source.alias + '.*' + (source.extraSelect ?? ''))}, ${hits} AS search_hits
          FROM ${sql.raw(source.table)} WHERE ${sql.raw(source.owner)} = ${owner} ${extraWhere} AND ${match}
          ORDER BY search_hits DESC, ${rank}, ${sql.raw(source.orderBy ?? 'updated_at DESC')} LIMIT ${query.perType}`.execute(db)
        rows = result.rows
      } finally {
        // 不race或强杀连接；等待真实执行和结果处理结束后优先传播取消。
        signal?.throwIfAborted()
      }
      return rows.map(row => source.map(row, terms))
    },
  }))
}
