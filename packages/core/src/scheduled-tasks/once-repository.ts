import { sql, type Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, utc, uuid } from '../data/codec.js'
import { enqueueScheduledTaskRagIndex } from './rag-index-job.js'

export interface OnceTaskRecord {
  id: string
  userId: string
  enabled: boolean
  scheduleKind: 'once'
  startAt: number
  lastRunAt: number | null
  lastRunFailed: boolean
}

function millis(value: unknown): number {
  const normalized = value instanceof Date ? value.toISOString() : utc(value).replace(' ', 'T')
  const time = Date.parse(normalized)
  if (!Number.isFinite(time)) throw new Error('定时任务时间无效')
  return time
}
function record(row: Record<string, unknown>): OnceTaskRecord {
  return {
    id: String(row.id), userId: uuid(String(row.user_id)), enabled: Boolean(row.enabled), scheduleKind: 'once',
    startAt: millis(row.start_at), lastRunAt: row.last_run_at == null ? null : millis(row.last_run_at),
    lastRunFailed: Boolean(row.last_run_failed),
  }
}

/** 持久化一次性任务状态；执行及恢复前调用方必须持有任务租约。 */
export function createKyselyOnceTaskRepository<DB>(db: Kysely<DB>, backend: 'sqlite' | 'postgres') {
  const time = (value: number) => databaseTime(new Date(value).toISOString(), backend)
  const dbOwner = (raw: string) => {
    const owner = dataContext(raw).ownerId
    return backend === 'sqlite' ? owner.replaceAll('-', '') : owner
  }
  return {
    async getOnce(id: string): Promise<OnceTaskRecord | null> {
      const result = await sql<Record<string, unknown>>`SELECT id,user_id,enabled,start_at,last_run_at,last_run_failed FROM scheduled_tasks WHERE id=${id} AND schedule_kind='once' AND user_id IS NOT NULL AND start_at IS NOT NULL`.execute(db)
      return result.rows[0] ? record(result.rows[0]) : null
    },
    async markStarted(id: string, at: number, owner: string, expectedStartAt?: number): Promise<boolean> {
      const result = await sql`UPDATE scheduled_tasks SET last_run_at=${time(at)},last_run_failed=FALSE WHERE id=${id} AND user_id=${dbOwner(owner)} AND enabled=TRUE AND schedule_kind='once' AND (last_run_at IS NULL OR last_run_failed=TRUE)
        ${expectedStartAt === undefined ? sql`` : sql`AND last_run_at IS NULL AND start_at >= ${time(expectedStartAt)} AND start_at < ${time(expectedStartAt + 1)}`}`.execute(db)
      return Number(result.numAffectedRows) === 1
    },
    async markFailed(id: string, owner: string): Promise<void> {
      await sql`UPDATE scheduled_tasks SET last_run_failed=TRUE WHERE id=${id} AND user_id=${dbOwner(owner)} AND schedule_kind='once' AND last_run_at IS NOT NULL`.execute(db)
    },
    async deleteCompleted(id: string, rawOwner: string): Promise<void> {
      const user = dbOwner(rawOwner)
      await db.transaction().execute(async tx => {
        const result = await sql<{ id: number }>`DELETE FROM scheduled_tasks WHERE id=${id} AND user_id=${user} AND schedule_kind='once' RETURNING id`.execute(tx)
        if (result.rows[0]) await enqueueScheduledTaskRagIndex(tx, backend, user, Number(result.rows[0].id))
      })
    },
    async findStartedOnceBefore(at: number): Promise<OnceTaskRecord[]> {
      const result = await sql<Record<string, unknown>>`SELECT id,user_id,enabled,start_at,last_run_at,last_run_failed FROM scheduled_tasks WHERE schedule_kind='once' AND user_id IS NOT NULL AND start_at IS NOT NULL AND last_run_at < ${time(at)} AND COALESCE(last_run_failed,FALSE)=FALSE`.execute(db)
      return result.rows.map(record)
    },
    async listPendingOnce(now: number) {
      const { rows } = await sql<{ id: number; start_at: string | Date }>`SELECT id,start_at FROM scheduled_tasks
        WHERE schedule_kind='once' AND enabled=TRUE AND user_id IS NOT NULL AND last_run_at IS NULL
          AND start_at >= ${time(now - 1000)} ORDER BY start_at,id`.execute(db)
      return rows.map(row => ({ id: String(row.id), kind: 'once' as const, startAt: millis(row.start_at) }))
    },
    async findExpiredUnstarted(before: number): Promise<OnceTaskRecord[]> {
      const { rows } = await sql<Record<string, unknown>>`SELECT id,user_id,enabled,start_at,last_run_at,last_run_failed FROM scheduled_tasks
        WHERE schedule_kind='once' AND user_id IS NOT NULL AND last_run_at IS NULL AND start_at < ${time(before)} ORDER BY start_at,id`.execute(db)
      return rows.map(record)
    },
    async deleteExpiredUnstarted(id: string, rawOwner: string, before: number): Promise<boolean> {
      const user = dbOwner(rawOwner)
      return db.transaction().execute(async tx => {
        const { rows: [removed] } = await sql<{ id: number }>`DELETE FROM scheduled_tasks WHERE id=${id} AND user_id=${user}
          AND schedule_kind='once' AND start_at < ${time(before)} AND last_run_at IS NULL RETURNING id`.execute(tx)
        if (!removed) return false
        await enqueueScheduledTaskRagIndex(tx, backend, user, Number(removed.id))
        return true
      })
    },
    async listDue(now: number): Promise<string[]> {
      const result = await sql<{ id: number }>`SELECT id FROM scheduled_tasks WHERE schedule_kind='once' AND enabled=TRUE AND user_id IS NOT NULL AND last_run_at IS NULL AND start_at <= ${time(now)} AND start_at >= ${time(now - 120_000)} ORDER BY start_at,id`.execute(db)
      return result.rows.map(row => String(row.id))
    },
  }
}
