import { Kysely, PostgresDialect, sql } from 'kysely'
import type { Pool } from 'pg'
import { CoreError, dataContext } from '../../contracts/index.js'
import { createSubagentDeliveryStore } from '../subagent/delivery-store.js'
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
export function createSqlAgentToolEventDetails(db: Kysely<any>, backend: 'postgres' | 'sqlite', getRunSecret?: () => string | Promise<string>) {
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
      if (getRunSecret && typeof event.runId === 'string'
        && (event.toolName === 'agent_wait' || event.toolName === 'subagent_result')) {
        const result = detailRecord(event.toolResult)
        const childId = detailRecord(result.run).childId ?? result.childId ?? detailRecord(event.toolInput).childId
        if (typeof childId === 'string' && /^[a-f0-9]{8}$/.test(childId)) {
          const deliveries = createSubagentDeliveryStore(db, await getRunSecret(), undefined, backend)
          const parent = { ownerId: normalized, sessionId: String(sessionId), runId: event.runId }
          const executionId = event.toolName === 'subagent_result' && typeof event.toolCallId === 'string'
            ? /^subagent-result:([a-f0-9-]{36})$/u.exec(event.toolCallId)?.[1]
            : typeof result.deliveryRunId === 'string' ? result.deliveryRunId : undefined
          const outcome = executionId ? await deliveries.readOutcomeByExecution(parent, executionId, childId)
            : (await deliveries.read(parent, childId))?.outcome
          if (outcome && 'finalMessage' in outcome) {
            details.toolResult = {
              ...result,
              childId, finalMessage: outcome.finalMessage,
            }
          }
        }
      }
      return sanitizeMediaPayload(details) as Record<string, unknown>
    } catch (error) {
      const e = error as { code?: string; message?: string }
      if (backend === 'sqlite' && e.code === 'SQLITE_ERROR' && /no such table: (?:conversation_sessions|conversation_messages)/.test(e.message ?? '')) throw new CoreError('schema_upgrade_required', '工具事件所需数据表尚未初始化')
      throw error
    }
  }
}

function detailRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return {} }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** 借用 Host 连接池，生命周期由 Host 管理。 */
export function createPostgresAgentToolEventDetails(pool: Pick<Pool, 'query' | 'connect'>, runSecret?: string) {
  return createSqlAgentToolEventDetails(new Kysely<any>({ dialect: new PostgresDialect({ pool: pool as Pool }) }), 'postgres', runSecret === undefined ? undefined : () => runSecret)
}
