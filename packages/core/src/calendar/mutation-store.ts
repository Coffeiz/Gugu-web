import { sql, type Kysely, type Transaction } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, utc, type Clock } from '../data/codec.js'
import type { Database } from '../data/schema.js'
import { recordForwardUndoOperation } from '../data/undo.js'
import { enqueueScheduledTaskRagIndex } from '../scheduled-tasks/rag-index-job.js'
import { enqueueCalendarRagIndex, insertCalendarEventReminder } from './create-store.js'
import type { PreparedEventReminder } from './application/event-create.js'
import { calendarEventRecord } from './event-projection.js'
import type { CalendarEventUpdateFields, EventUpdatePublication, EventUpdateReminderRecord, EventUpdateStore, EventUpdateTransaction } from './application/event-update.js'
import type { CalendarEventDeletePublication, CalendarEventDeleteStore, CalendarEventDeleteTransaction } from './application/event-delete.js'

type Backend = 'sqlite' | 'postgres'
type Row = Record<string, unknown>
const eventFields = sql`id,title,date,time,end_time,type,contact_name AS client,project_id,description,version,deleted_at`

function reminder(row: Row, backend: Backend) {
  const start = row.start_at
  const targets = row.delivery_targets
  return {
    execution_mode: row.execution_mode === 'instruction' ? 'instruction' as const : row.execution_mode === 'reminder' ? 'reminder' as const : undefined,
    id: Number(row.id), enabled: Boolean(row.enabled), name: String(row.name), payload: String(row.payload ?? ''),
    cron: String(row.cron), schedule_kind: String(row.schedule_kind),
    start_at: start == null ? null : start instanceof Date ? start : backend === 'sqlite' ? utc(String(start)).replace(' ', 'T') : String(start),
    reminder_lead_minutes: row.reminder_lead_minutes == null ? null : Number(row.reminder_lead_minutes),
    channels: String(row.channels),
    delivery_targets: backend === 'sqlite' && typeof targets === 'string' ? JSON.parse(targets) : targets ?? null,
  }
}

function adapter<DB>(tx: Transaction<DB>, backend: Backend, rawOwner: string, clock: Clock) {
  const normalized = dataContext(rawOwner).ownerId
  const owner = backend === 'sqlite' ? normalized.replaceAll('-', '') : normalized
  const timestamp = () => backend === 'sqlite' ? sql`${databaseTime(clock(), backend)}` : sql`CURRENT_TIMESTAMP`
  const queuedTaskIds = new Set<number>()
  const enqueueTaskRag = async (id: number) => {
    if (queuedTaskIds.has(id)) return
    await enqueueScheduledTaskRagIndex(tx, backend, owner, id, timestamp())
    queuedTaskIds.add(id)
  }
  return {
    async findOwnedActiveEvent(id: number) {
      const result = await sql<Row>`SELECT ${eventFields} FROM calendar_events WHERE id=${id} AND user_id=${owner} AND deleted_at IS NULL LIMIT 1`.execute(tx)
      const row = result.rows[0]
      return row ? calendarEventRecord(row, Number(row.version || 1)) : null
    },
    async projectExistsForOwner(id: number) {
      return (await sql`SELECT id FROM projects WHERE id=${id} AND user_id=${owner} AND deleted_at IS NULL`.execute(tx)).rows.length > 0
    },
    async listOwnedEventReminders(id: number) {
      const result = await sql<Row>`SELECT id,enabled,name,payload,cron,execution_mode,schedule_kind,start_at,reminder_lead_minutes,channels,delivery_targets FROM scheduled_tasks WHERE user_id=${owner} AND event_id=${id} ORDER BY id`.execute(tx)
      return result.rows.map(row => reminder(row, backend))
    },
    async updateEventIfVersion(id: number, version: number, fields: CalendarEventUpdateFields) {
      const names: Record<keyof CalendarEventUpdateFields, string> = { title: 'title', date: 'date', time: 'time', end_time: 'end_time', type: 'type', client: 'contact_name', project_id: 'project_id', description: 'description' }
      const assignments = Object.entries(fields).map(([key, value]) => {
        const name = names[key as keyof CalendarEventUpdateFields]
        if (!name) throw new Error('不支持的日历字段')
        return sql`${sql.ref(name)} = ${value}`
      })
      const setClause = assignments.length ? sql`version=version+1, ${sql.join(assignments)}` : sql`version=version+1`
      const result = await sql<Row>`UPDATE calendar_events SET ${setClause} WHERE id=${id} AND user_id=${owner} AND deleted_at IS NULL AND version=${version} RETURNING ${eventFields}`.execute(tx)
      const row = result.rows[0]
      if (row) await enqueueCalendarRagIndex(tx, backend, owner, String(id), timestamp(), 'update')
      return row ? calendarEventRecord(row, Number(row.version || 1)) : null
    },
    async stageReminderCron(id: number, cron: string) {
      const result = await sql`UPDATE scheduled_tasks SET cron=${cron},updated_at=${timestamp()} WHERE id=${id} AND user_id=${owner}`.execute(tx)
      if (Number(result.numAffectedRows) !== 1) throw new Error('活动提醒不存在')
      await enqueueTaskRag(id)
    },
    async updateReminder(id: number, update: Parameters<EventUpdateTransaction['updateReminder']>[1]) {
      const schedule = update.schedule
      const start = schedule ? backend === 'sqlite' ? databaseTime(schedule.startAt.toISOString(), backend) : schedule.startAt : null
      const result = await sql`UPDATE scheduled_tasks SET name=${update.name},payload=${update.payload},schedule_kind=COALESCE(${schedule?.scheduleKind ?? null},schedule_kind),cron=COALESCE(${schedule?.cron ?? null},cron),start_at=COALESCE(${start},start_at),reminder_lead_minutes=COALESCE(${schedule?.reminderLeadMinutes ?? null},reminder_lead_minutes),channels=COALESCE(${schedule?.channels ?? null},channels),updated_at=${timestamp()} WHERE id=${id} AND user_id=${owner}`.execute(tx)
      if (Number(result.numAffectedRows) !== 1) throw new Error('活动提醒不存在')
      await enqueueTaskRag(id)
    },
    async replaceEventReminders(event: import('./application/event-update.js').CalendarEventUpdateRecord, reminders: readonly PreparedEventReminder[]) {
      const existing = await this.listOwnedEventReminders(event.id)
      const byCron = new Map(existing.map(task => [task.cron, task]))
      const requested = new Map(reminders.map(reminder => [reminder.cron, reminder]))
      const removed = existing.filter(task => !requested.has(task.cron))
      for (const task of removed) {
        await sql`DELETE FROM scheduled_tasks WHERE user_id=${owner} AND event_id=${event.id} AND id=${task.id}`.execute(tx)
        await enqueueTaskRag(task.id)
      }
      const result: EventUpdateReminderRecord[] = []
      for (const reminder of reminders) {
        const current = byCron.get(reminder.cron)
        if (!current) {
          const inserted = await insertCalendarEventReminder(tx, backend, owner, event.id, reminder, timestamp())
          result.push({ execution_mode: 'reminder', id: inserted.id, enabled: inserted.enabled, name: inserted.name, payload: inserted.payload, cron: inserted.cron,
            schedule_kind: inserted.scheduleKind, start_at: inserted.startAt, reminder_lead_minutes: inserted.leadMinutes,
            channels: inserted.channels, delivery_targets: inserted.deliveryTargets })
          continue
        }
        const start = backend === 'sqlite' ? databaseTime(reminder.startAt.toISOString(), backend) : reminder.startAt
        const enabled = backend === 'sqlite' ? Number(reminder.enabled) : reminder.enabled
        const targetJson = JSON.stringify(reminder.deliveryTargets ?? null)
        const targets = backend === 'postgres' ? sql`${targetJson}::json` : sql`${targetJson}`
        await sql`UPDATE scheduled_tasks SET name=${reminder.name},payload=${reminder.payload},cron=${reminder.cron},schedule_kind=${reminder.scheduleKind},
          start_at=${start},reminder_lead_minutes=${reminder.leadMinutes},channels=${reminder.channels},enabled=${enabled},delivery_targets=${targets},execution_mode='reminder',updated_at=${timestamp()}
          WHERE user_id=${owner} AND event_id=${event.id} AND id=${current.id}`.execute(tx)
        await enqueueTaskRag(current.id)
        result.push({ execution_mode: 'reminder', id: current.id, enabled: reminder.enabled, name: reminder.name, payload: reminder.payload, cron: reminder.cron,
          schedule_kind: reminder.scheduleKind, start_at: reminder.startAt, reminder_lead_minutes: reminder.leadMinutes,
          channels: reminder.channels, delivery_targets: reminder.deliveryTargets })
      }
      return result
    },
    async softDeleteEventIfVersion(id: number, version: number) {
      const result = await sql<Row>`UPDATE calendar_events SET deleted_at=${timestamp()},version=version+1 WHERE id=${id} AND user_id=${owner} AND deleted_at IS NULL AND version=${version} RETURNING ${eventFields}`.execute(tx)
      const row = result.rows[0]
      if (row) await enqueueCalendarRagIndex(tx, backend, owner, String(id), timestamp(), 'delete')
      return row ? calendarEventRecord(row, Number(row.version || 1)) : null
    },
    async disableReminders(eventId: number, ids: number[]) {
      if (!ids.length) return
      const changed = await sql<{ id: number }>`UPDATE scheduled_tasks SET enabled=${backend === 'sqlite' ? 0 : false} WHERE user_id=${owner} AND event_id=${eventId} AND id IN (${sql.join(ids)}) RETURNING id`.execute(tx)
      for (const row of changed.rows) await enqueueTaskRag(Number(row.id))
    },
    async recordUndo(record: Parameters<EventUpdateTransaction['recordUndo']>[0] | Parameters<CalendarEventDeleteTransaction['recordUndo']>[0]) {
      await recordForwardUndoOperation(tx as unknown as Transaction<Database>, backend, { ...record, userId: rawOwner }, clock)
    },
  }
}

/** 保留提交后发布边界；SQLite 调用方须使用 BEGIN IMMEDIATE 或单写者事务。 */
export function createKyselyCalendarMutationStores<DB>(db: Kysely<DB>, backend: Backend, publish: (event: EventUpdatePublication | CalendarEventDeletePublication) => Promise<unknown>, clock: Clock = nowUtc): { update: EventUpdateStore; delete: CalendarEventDeleteStore } {
  return {
    update: {
      transaction: (owner, work) => db.transaction().execute(tx => work(adapter(tx, backend, owner, clock))),
      publishCalendarEvent: async event => { await publish(event) },
    },
    delete: {
      transaction: (owner, work) => db.transaction().execute(tx => work(adapter(tx, backend, owner, clock))),
      publishResourceChanged: async event => { await publish(event) },
    },
  }
}

/** Borrow the desktop operation-receipt transaction and stage RAG invalidation before it commits. */
export function createBorrowedKyselyCalendarMutationStores<DB>(tx: Transaction<DB>, backend: Backend, clock: Clock = nowUtc): { update: EventUpdateStore; delete: CalendarEventDeleteStore } {
  return {
    update: {
      transaction: (owner, work) => work(adapter(tx, backend, owner, clock)),
      async publishCalendarEvent() {},
    },
    delete: {
      transaction: (owner, work) => work(adapter(tx, backend, owner, clock)),
      async publishResourceChanged() {},
    },
  }
}
