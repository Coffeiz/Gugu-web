import { sql, type Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'
import type { GlobalSearchSource } from './global-search.js'
import { SEARCH_SOURCES } from './sources.js'

/** 正式SQLite目前只装配这三个表；其余来源由公共编排明确报能力缺失。 */
export function createKyselySqliteGlobalSearchSources<DB>(db: Kysely<DB>): GlobalSearchSource[] {
  return SEARCH_SOURCES.filter(source => ['project', 'client', 'event'].includes(source.type)).map(source => ({
    type: source.type,
    label: source.label,
    async search(rawOwner, query, signal) {
      signal?.throwIfAborted()
      const owner = dataContext(rawOwner).ownerId.replaceAll('-', '')
      const terms = Object.freeze([...query.queries])
      if (!terms.length) return []
      // SQL结构只来自可信内置metadata；owner、关键词和limit始终绑定参数。
      const hits = sql`(${sql.join(terms.map(term => {
        const fields = source.searchable.map(column => sql`lower(COALESCE(${sql.raw(column)}, '')) LIKE lower(${'%' + term + '%'})`)
        return sql`CASE WHEN (${sql.join(fields, sql` OR `)}) THEN 1 ELSE 0 END`
      }), sql` + `)})`
      const match = query.mode === 'AND' ? sql`${hits} = ${terms.length}` : sql`${hits} > 0`
      const rank = sql`CASE WHEN lower(${sql.raw(source.title)}) = lower(${terms[0]}) THEN 0
        WHEN lower(${sql.raw(source.title)}) LIKE lower(${terms[0]}) || '%' THEN 1 ELSE 2 END`
      let rows: Record<string, unknown>[]
      try {
        const result = await sql<Record<string, unknown>>`SELECT ${sql.raw(source.alias + '.*')}, ${hits} AS search_hits
          FROM ${sql.raw(source.table)} WHERE ${sql.raw(source.owner)} = ${owner} ${sql.raw(source.extraWhere ?? '')} AND ${match}
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
