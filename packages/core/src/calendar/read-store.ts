import { sql, type Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'
import type { CalendarEventReadPort } from './application/event-read.js'
import { calendarEventRecord } from './event-projection.js'

async function read<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  try { return await work() }
  // 无论驱动成功或拒绝，均等待其完成后再优先传播原取消原因。
  finally { signal?.throwIfAborted() }
}

/** Host持有连接生命周期；此端口只查询存活事件，不聚合提醒或创建表。 */
export function createKyselyCalendarReadPort<DB>(db: Kysely<DB>, backend: 'sqlite' | 'postgres'): CalendarEventReadPort {
  const owner = (raw: string) => {
    const normalized = dataContext(raw).ownerId
    return backend === 'sqlite' ? normalized.replaceAll('-', '') : normalized
  }
  return {
    async list(ownerId, datePrefix, signal) {
      signal?.throwIfAborted()
      const ownerIdValue = owner(ownerId)
      const filter = datePrefix === undefined ? sql`` : sql` AND date LIKE ${datePrefix + '%'}`
      const result = await read(() => sql<Record<string, unknown>>`SELECT id,title,date,time,end_time,type,contact_name AS client,project_id,description,version
        FROM calendar_events WHERE user_id=${ownerIdValue} AND deleted_at IS NULL${filter} ORDER BY date`.execute(db), signal)
      return result.rows.map(row => calendarEventRecord(row, Number(row.version ?? 1)))
    },
    async get(ownerId, eventId, signal) {
      signal?.throwIfAborted()
      const ownerIdValue = owner(ownerId)
      const result = await read(() => sql<Record<string, unknown>>`SELECT id,title,date,time,end_time,type,contact_name AS client,project_id,description,version
        FROM calendar_events WHERE user_id=${ownerIdValue} AND id=${eventId} AND deleted_at IS NULL LIMIT 1`.execute(db), signal)
      const row = result.rows[0]
      return row ? calendarEventRecord(row, Number(row.version ?? 1)) : null
    },
  }
}

/** Agent范围查询与提醒读取使用同一事务；SQL不包含调度、清理或写入。 */
export function createKyselyCalendarAgentReadPort<DB>(db: Kysely<DB>, backend: 'sqlite' | 'postgres'): import('./application/event-read.js').CalendarAgentReadPort {
  return { async list(rawOwner, query, signal) {
    signal?.throwIfAborted()
    const normalized = dataContext(rawOwner).ownerId, owner = backend === 'sqlite' ? normalized.replaceAll('-', '') : normalized
    return read(() => db.transaction().execute(async tx => {
      const start = query.from ? sql` AND date >= ${query.from}` : sql``
      const end = query.to ? sql` AND date <= ${query.to}` : sql``
      const type = query.type ? sql` AND type = ${query.type}` : sql``
      const rows = (await sql<Record<string, unknown>>`SELECT id,title,date,time,end_time,type,contact_name AS client,project_id,description,version
        FROM calendar_events WHERE user_id=${owner} AND deleted_at IS NULL${start}${end}${type} ORDER BY date LIMIT ${query.limit}`.execute(tx)).rows
      const events = rows.map(row => calendarEventRecord(row, Number(row.version ?? 1)))
      const reminders = new Map<number, import('./application/event-update.js').EventUpdateReminderRecord[]>()
      if (events.length) {
        signal?.throwIfAborted()
        const stamp = backend === 'postgres' ? sql`to_char(start_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00:00'` : sql`start_at`
        const tasks = (await sql<Record<string, unknown>>`SELECT id,event_id,enabled,name,payload,cron,schedule_kind,${stamp} AS start_at,
          reminder_lead_minutes,channels,delivery_targets FROM scheduled_tasks WHERE user_id=${owner} AND event_id IN (${sql.join(events.map(event => event.id))}) ORDER BY id`.execute(tx)).rows
        for (const task of tasks) {
          const id = Number(task.event_id), group = reminders.get(id) ?? []
          group.push({ id: Number(task.id), enabled: Boolean(task.enabled), name: String(task.name), payload: String(task.payload ?? ''),
            cron: String(task.cron), schedule_kind: String(task.schedule_kind), start_at: task.start_at == null ? null : String(task.start_at),
            reminder_lead_minutes: task.reminder_lead_minutes == null ? null : Number(task.reminder_lead_minutes), channels: task.channels == null ? null : String(task.channels),
            delivery_targets: backend === 'sqlite' && typeof task.delivery_targets === 'string' ? JSON.parse(task.delivery_targets) : task.delivery_targets })
          reminders.set(id, group)
        }
      }
      return { events, reminders }
    }), signal)
  } }
}
