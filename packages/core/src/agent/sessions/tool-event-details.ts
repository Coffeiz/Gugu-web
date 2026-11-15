import { Kysely, PostgresDialect, sql } from 'kysely'
import type { Pool } from 'pg'
import { CoreError, dataContext } from '../../contracts/index.js'
import { sanitizeMediaPayload } from '../context/messages/index.js'

export class AgentToolEventSessionNotFoundError extends Error {
  readonly statusCode = 404
  constructor() { super('对话不存在') }
}
export class AgentToolEventDetailsNotFoundError extends Error {
  readonly statusCode = 404
  constructor() { super('工具事件不存在') }
}

/** 读取前校验 owner；数据库侧限制旧的大型时间线，避免加载到进程。 */
export function createSqlAgentToolEventDetails(db: Kysely<any>, backend: 'postgres' | 'sqlite') {
  return async (ownerId: string, sessionId: number, messageId: number, timelineIndex: number): Promise<Record<string, unknown>> => {
    const normalized = dataContext(ownerId).ownerId
    const owner = backend === 'sqlite' ? normalized.replaceAll('-', '') : normalized
    try {
      const session = await sql`SELECT id FROM conversation_sessions WHERE id=${sessionId} AND user_id=${owner}`.execute(db)
      if (!session.rows.length) throw new AgentToolEventSessionNotFoundError()
      const size = backend === 'postgres' ? sql`pg_column_size(display_timeline)` : sql`length(CAST(display_timeline AS TEXT))`
      const result = await sql<{ display_timeline: unknown }>`SELECT CASE WHEN ${size} > 1048576 THEN NULL ELSE display_timeline END AS display_timeline FROM conversation_messages WHERE id=${messageId} AND session_id=${sessionId} AND EXISTS (SELECT 1 FROM conversation_sessions WHERE id=${sessionId} AND user_id=${owner})`.execute(db)
      let timeline = result.rows[0]?.display_timeline
      if (backend === 'sqlite' && typeof timeline === 'string') {
        try { timeline = JSON.parse(timeline) } catch { throw new CoreError('storage_error', '工具事件数据格式无效') }
      }
      if (!Array.isArray(timeline) || timelineIndex < 0 || timelineIndex >= timeline.length) throw new AgentToolEventDetailsNotFoundError()
      const event = timeline[timelineIndex]
      if (!event || typeof event !== 'object' || Array.isArray(event) || event.kind !== 'tool') throw new AgentToolEventDetailsNotFoundError()
      const details: Record<string, unknown> = {}
      for (const key of ['toolInput', 'toolResult']) if (key in event) details[key] = event[key]
      return sanitizeMediaPayload(details) as Record<string, unknown>
    } catch (error) {
      const e = error as { code?: string; message?: string }
      if (backend === 'sqlite' && e.code === 'SQLITE_ERROR' && /no such table: (?:conversation_sessions|conversation_messages)/.test(e.message ?? '')) throw new CoreError('schema_upgrade_required', '工具事件所需数据表尚未初始化')
      throw error
    }
  }
}

/** 借用 Host 连接池，生命周期由 Host 管理。 */
export function createPostgresAgentToolEventDetails(pool: Pick<Pool, 'query' | 'connect'>) {
  return createSqlAgentToolEventDetails(new Kysely<any>({ dialect: new PostgresDialect({ pool: pool as Pool }) }), 'postgres')
}
