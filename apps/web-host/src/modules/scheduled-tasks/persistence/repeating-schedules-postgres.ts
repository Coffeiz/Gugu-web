import type { Pool } from 'pg'
import { dueRepeatingFire, type RepeatingSchedule } from '../repeating-poller.js'
import type { ScheduledFire } from '../repeating-dispatch.js'

type Row = { id: number; schedule_kind: 'cron' | 'interval'; cron: string; interval_minutes: number | null; start_at: Date | null; created_at: Date; end_at: Date | null }
function schedule(row: Row): RepeatingSchedule {
  return { id: String(row.id), kind: row.schedule_kind, cron: row.cron,
    intervalMinutes: row.interval_minutes, startAt: row.start_at?.getTime() ?? null,
    createdAt: row.created_at.getTime(), endAt: row.end_at?.getTime() ?? null }
}

/** 读取启用的重复任务；执行前仍须持锁并复核其当前状态。 */
export function createPostgresRepeatingSchedules(pool: Pick<Pool, 'query'>) {
  return async (): Promise<RepeatingSchedule[]> => {
    const result = await pool.query<Row>(
      `SELECT id,schedule_kind,cron,interval_minutes,start_at,created_at,end_at FROM scheduled_tasks
       WHERE user_id IS NOT NULL AND enabled=TRUE AND schedule_kind IN ('cron','interval') ORDER BY id`,
    )
    return result.rows.map(schedule)
  }
}

export function createPostgresRepeatingScheduleRecheck(pool: Pick<Pool, 'query'>) {
  return async (fire: ScheduledFire): Promise<boolean> => {
    const result = await pool.query<Row>(`SELECT id,schedule_kind,cron,interval_minutes,start_at,created_at,end_at
      FROM scheduled_tasks WHERE id=$1 AND user_id IS NOT NULL AND enabled=TRUE AND schedule_kind IN ('cron','interval')`, [fire.taskId])
    return !!result.rows[0] && dueRepeatingFire(schedule(result.rows[0]), fire.fireAt, 0)?.fireAt === fire.fireAt
  }
}
