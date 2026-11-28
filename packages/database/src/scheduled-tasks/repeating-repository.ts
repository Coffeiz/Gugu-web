import { sql, type Kysely, type Transaction } from 'kysely'
import type { ScheduleDatabaseBackend, ScheduleDatabaseCodec, ScheduleTaskDeleted, StoppedScheduleRow } from './ports.js'

interface RepeatingRow {
  id: number
  user_id: string
  event_id: number | null
  schedule_kind: 'cron' | 'interval'
  cron: string
  interval_minutes: number | null
  start_at: Date | string | null
  end_at: Date | string | null
  created_at: Date | string
  schedule_version: string
}

function instant(value: string | Date, codec: ScheduleDatabaseCodec): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(codec.readTime(value).replace(' ', 'T'))
  if (!Number.isFinite(parsed)) throw new Error('周期任务时间无效')
  return parsed
}

function schedule(row: RepeatingRow, codec: ScheduleDatabaseCodec) {
  return {
    id: String(row.id), userId: codec.readOwner(row.user_id), eventId: row.event_id, kind: row.schedule_kind, cron: row.cron,
    intervalMinutes: row.interval_minutes, createdAt: instant(row.created_at, codec),
    startAt: row.start_at === null ? null : instant(row.start_at, codec),
    endAt: row.end_at === null ? null : instant(row.end_at, codec), version: row.schedule_version,
  }
}

export type RepeatingTask = ReturnType<typeof schedule>

export function createKyselyRepeatingTaskRepository<DB, StopEffects>(
  db: Kysely<DB>, backend: ScheduleDatabaseBackend, codec: ScheduleDatabaseCodec, effects: {
    onDelete: ScheduleTaskDeleted<DB>
    onStop(tx: Transaction<DB>, owner: string, row: StoppedScheduleRow, effects: StopEffects): Promise<void>
  },
) {
  const { writeTime: time, writeOwner: storedOwner } = codec
  const fields = sql`id,user_id,event_id,schedule_kind,cron,interval_minutes,start_at,created_at,end_at,CAST(updated_at AS TEXT) AS schedule_version`
  const enabled = sql`user_id IS NOT NULL AND enabled=TRUE AND schedule_kind IN ('cron','interval')`
  const ended = (now: number) => sql`user_id IS NOT NULL AND event_id IS NULL AND schedule_kind IN ('cron','interval') AND end_at<=${time(now)}`

  return {
    async list(now: number): Promise<RepeatingTask[]> {
      const { rows } = await sql<RepeatingRow>`SELECT ${fields} FROM scheduled_tasks
        WHERE ${enabled} AND (end_at IS NULL OR end_at>${time(now)}) ORDER BY id`.execute(db)
      return rows.map(row => schedule(row, codec))
    },
    async isCurrent(task: RepeatingTask, now: number): Promise<boolean> {
      const { rows } = await sql`SELECT 1 FROM scheduled_tasks WHERE ${enabled} AND id=${task.id}
        AND user_id=${storedOwner(task.userId)} AND schedule_kind=${task.kind} AND CAST(updated_at AS TEXT)=${task.version}
        AND (end_at IS NULL OR end_at>${time(now)})`.execute(db)
      return rows.length === 1
    },
    async markStarted(task: RepeatingTask, now: number): Promise<boolean> {
      const result = await sql`UPDATE scheduled_tasks SET last_run_at=${time(now)} WHERE ${enabled} AND id=${task.id}
        AND user_id=${storedOwner(task.userId)} AND schedule_kind=${task.kind} AND CAST(updated_at AS TEXT)=${task.version}
        AND (end_at IS NULL OR end_at>${time(now)})`.execute(db)
      return Number(result.numAffectedRows) === 1
    },
    async stopAfterRun(task: Pick<RepeatingTask, 'id' | 'userId' | 'version'>, stopEffects: StopEffects,
      assertLease?: () => Promise<void>): Promise<boolean> {
      const owner = storedOwner(task.userId)
      const updatedAt = backend === 'postgres' ? sql`CURRENT_TIMESTAMP` : sql`${time(Date.now())}`
      return db.transaction().execute(async tx => {
        const { rows: [row] } = await sql<StoppedScheduleRow>`
          UPDATE scheduled_tasks SET enabled=FALSE,updated_at=${updatedAt}
          WHERE ${enabled} AND id=${task.id} AND user_id=${owner} AND event_id IS NULL
            AND CAST(updated_at AS TEXT)=${task.version}
          RETURNING id,name,filesystem_authorization_grant_id`.execute(tx)
        if (!row) return false
        await assertLease?.()
        await effects.onStop(tx, owner, row, stopEffects)
        await assertLease?.()
        return true
      })
    },
    async listEnded(now: number): Promise<Array<{ id: string; userId: string }>> {
      const { rows } = await sql<{ id: number; user_id: string }>`SELECT id,user_id FROM scheduled_tasks WHERE ${ended(now)} ORDER BY id`.execute(db)
      return rows.map(row => ({ id: String(row.id), userId: codec.readOwner(row.user_id) }))
    },
    async deleteEnded(task: { id: string; userId: string }, now: number): Promise<boolean> {
      const owner = storedOwner(task.userId)
      return db.transaction().execute(async tx => {
        const { rows } = await sql<{ id: number }>`DELETE FROM scheduled_tasks WHERE id=${task.id}
          AND user_id=${owner} AND ${ended(now)} RETURNING id`.execute(tx)
        if (!rows[0]) return false
        await effects.onDelete(tx, owner, rows[0].id)
        return true
      })
    },
  }
}
