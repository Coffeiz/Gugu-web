import { sql, type Kysely } from 'kysely'
import type { ScheduleDatabaseBackend } from './ports.js'

/** 查询只接受调用方已校验且按数据库编码的 owner。 */
export function createScheduledTaskListStorage<DB>(db: Kysely<DB>, backend: ScheduleDatabaseBackend, sqliteMode: boolean) {
  const time = (column: string) => backend === 'postgres'
    ? sql`to_char(${sql.ref(column)} AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00:00'`
    : sql.ref(column)
  return async (owner: string, eventId: number | null | 'all', taskId?: number, page?: { before?: number; limit: number }) => {
    const event = eventId === 'all' ? sql`TRUE` : eventId === null ? sql`event_id IS NULL` : sql`event_id=${eventId}`
    const filter = taskId === undefined ? sql`` : sql`AND id=${taskId}`
    const before = page?.before === undefined ? sql`` : sql`AND id<${page.before}`
    const limit = page ? sql`LIMIT ${page.limit}` : sql``
    const { rows } = await sql<Record<string, unknown>>`SELECT id,name,payload,cron,schedule_kind,interval_minutes,
      ${backend === 'postgres' || sqliteMode ? sql`execution_mode` : sql`'instruction' AS execution_mode`},
      ${time('start_at')} AS start_at,${time('end_at')} AS end_at,channels,enabled,event_id,workspace_id,filesystem_authorization_grant_id,
      ${time('last_run_at')} AS last_run_at,last_run_failed,delivery_targets,authorized_tools,email_attachment_file_paths
      FROM scheduled_tasks WHERE user_id=${owner} AND ${event} ${filter} ${before} ORDER BY id DESC ${limit}`.execute(db)
    return rows
  }
}

export async function readScheduledTaskIndexRows<DB>(db: Kysely<DB>, backend: ScheduleDatabaseBackend, owner: string, id: number | null) {
  const time = backend === 'postgres' ? sql`to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00:00'` : sql`updated_at`
  const filter = id === null ? sql`` : sql`AND id=${id}`
  const { rows } = await sql<{ id: number; name: string; payload: string; cron: string; enabled: boolean | number; updated_at: string }>`
    SELECT id,name,payload,cron,enabled,${time} AS updated_at FROM scheduled_tasks
    WHERE user_id=${owner} ${filter} ORDER BY updated_at DESC,id DESC`.execute(db)
  return rows
}
