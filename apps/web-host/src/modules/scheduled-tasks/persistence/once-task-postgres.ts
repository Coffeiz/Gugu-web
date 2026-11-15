import type { Pool } from 'pg'
import type { OnceTaskRepository, ScheduledTaskRecord } from '../../../scheduled-task-runner.js'

type Row = { id: number; user_id: string; enabled: boolean; start_at: Date; last_run_at: Date | null; last_run_failed: boolean | null }

function record(row: Row): ScheduledTaskRecord {
  return { id: String(row.id), userId: row.user_id, enabled: row.enabled, scheduleKind: 'once',
    startAt: new Date(row.start_at).getTime(), lastRunAt: row.last_run_at ? new Date(row.last_run_at).getTime() : null,
    lastRunFailed: Boolean(row.last_run_failed) }
}

/** 一次性任务状态持久化；调用方必须先持有与 Python 兼容的任务租约。 */
export function createPostgresOnceTaskRepository(pool: Pick<Pool, 'query'>): OnceTaskRepository {
  const columns = 'id, user_id::text AS user_id, enabled, start_at, last_run_at, last_run_failed'
  return {
    async getOnce(id) {
      const result = await pool.query<Row>(`SELECT ${columns} FROM scheduled_tasks WHERE id=$1 AND schedule_kind='once' AND user_id IS NOT NULL AND start_at IS NOT NULL`, [id])
      return result.rows[0] ? record(result.rows[0]) : null
    },
    async markStarted(id, at) {
      const result = await pool.query(`UPDATE scheduled_tasks SET last_run_at=$2, last_run_failed=FALSE WHERE id=$1 AND enabled=TRUE AND schedule_kind='once' AND (last_run_at IS NULL OR last_run_failed=TRUE)`, [id, new Date(at)])
      return result.rowCount === 1
    },
    async markFailed(id) {
      await pool.query(`UPDATE scheduled_tasks SET last_run_failed=TRUE WHERE id=$1 AND schedule_kind='once' AND last_run_at IS NOT NULL`, [id])
    },
    async deleteCompleted(id, userId) {
      await pool.query(`DELETE FROM scheduled_tasks WHERE id=$1 AND user_id=$2 AND schedule_kind='once'`, [id, userId])
    },
    async findStartedOnceBefore(at) {
      const result = await pool.query<Row>(`SELECT ${columns} FROM scheduled_tasks WHERE schedule_kind='once' AND user_id IS NOT NULL AND start_at IS NOT NULL AND last_run_at < $1 AND COALESCE(last_run_failed,FALSE)=FALSE`, [new Date(at)])
      return result.rows.map(record)
    },
  }
}

/** 只选择从未执行且尚处于 Python 120 秒误触发宽限期内的一次性任务。 */
export function createPostgresDueOnceTasks(pool: Pick<Pool, 'query'>) {
  return async (now: number): Promise<string[]> => {
    const result = await pool.query<{ id: number }>(`SELECT id FROM scheduled_tasks
      WHERE schedule_kind='once' AND enabled=TRUE AND user_id IS NOT NULL
        AND last_run_at IS NULL AND start_at <= $1 AND start_at >= $2 ORDER BY start_at, id`,
    [new Date(now), new Date(now - 120_000)])
    return result.rows.map((row) => String(row.id))
  }
}
