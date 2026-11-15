import { Kysely, PostgresDialect, sql } from 'kysely'
import type { Pool } from 'pg'
import { CoreError, dataContext } from '../../contracts/index.js'
import { isCanonicalSqliteTime } from '../../data/sqlite-time-sql.js'

/** 只读取当前用户的群会话中，候选平台身份最近一次有效发言的昵称。 */
export function createSqlAgentGroupNames(db: Kysely<any>, backend: 'postgres' | 'sqlite') {
  return async (ownerId: string, sessionId: number, candidates: readonly string[]): Promise<Map<string, string>> => {
    const canonical = dataContext(ownerId).ownerId
    if (!Number.isSafeInteger(sessionId) || sessionId < 1 || !Array.isArray(candidates) || candidates.some(id => typeof id !== 'string'))
      throw new CoreError('invalid_request', '群会话查询参数无效')
    const ids = [...new Set(candidates.filter(Boolean))]
    if (!ids.length) return new Map()
    const owner = backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    const inCandidates = backend === 'sqlite'
      ? sql`m.platform_user_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`
      : sql`m.platform_user_id = ANY(${ids}::text[])`
    const validTime = backend === 'sqlite' ? isCanonicalSqliteTime(sql`created_at`) : sql`TRUE`
    const rows = await sql<{ id: string | null; name: string | null; bad: number | string }>`WITH candidates AS (
      SELECT m.id,m.platform_user_id,m.platform_user_name,m.created_at
      FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id
      WHERE s.id=${sessionId} AND s.user_id=${owner} AND s.chat_type='group' AND s.source IS NOT NULL AND s.source<>'' AND ${inCandidates}
        AND m.platform_user_name IS NOT NULL AND m.platform_user_name<>''
    ), integrity AS (SELECT COUNT(*) AS bad FROM candidates WHERE NOT (${validTime})),
    ranked AS (SELECT platform_user_id,platform_user_name, ROW_NUMBER() OVER (
      PARTITION BY platform_user_id ORDER BY created_at DESC,id DESC) AS position FROM candidates)
    SELECT ranked.platform_user_id AS id,ranked.platform_user_name AS name,integrity.bad FROM integrity
      LEFT JOIN ranked ON ranked.position=1`.execute(db)
    if (Number(rows.rows[0]?.bad ?? 0) !== 0) throw new CoreError('storage_error', '群会话消息时间格式无效')
    const names = new Map<string, string>()
    for (const row of rows.rows) if (row.id && row.name) names.set(row.id, row.name)
    return names
  }
}

/** PostgreSQL 连接池由 Host 持有和关闭。 */
export function createPostgresAgentGroupNames(pool: Pool) {
  return createSqlAgentGroupNames(new Kysely<any>({ dialect: new PostgresDialect({ pool }) }), 'postgres')
}
