import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import { recordForwardUndoOperation } from '../../undo/persistence/forward-operation.js'
import { projectExistsForOwner as isProjectOwnedAndActive } from '../../projects/persistence/projects.js'
import { calendarEventRecord } from '../event-projection.js'
import { findOwnedActiveEvent as findCalendarEventByOwner } from './events.js'
import type {
  CalendarEventUpdateFields,
  EventUpdatePublication,
  EventUpdateReminderRecord,
  EventUpdateReminderSchedule,
  EventUpdateStore,
  EventUpdateTransaction,
} from '../application/event-update.js'

type DatabaseRow = Record<string, unknown>
type EventUpdatePublisher = (publication: EventUpdatePublication) => Promise<unknown>
type PublicationFailureReporter = (operation: string) => void

function reminderRecord(row: DatabaseRow): EventUpdateReminderRecord {
  return {
    id: Number(row.id),
    enabled: Boolean(row.enabled),
    name: String(row.name),
    payload: String(row.payload ?? ''),
    cron: String(row.cron),
    schedule_kind: String(row.schedule_kind),
    start_at: row.start_at == null ? null : row.start_at instanceof Date ? row.start_at : String(row.start_at),
    reminder_lead_minutes: row.reminder_lead_minutes == null ? null : Number(row.reminder_lead_minutes),
    channels: row.channels == null ? null : String(row.channels),
    delivery_targets: row.delivery_targets ?? null,
  }
}

function transactionAdapter(client: PoolClient, ownerId: string): EventUpdateTransaction {
  const eventColumns = `id, title, date, time, end_time, type, contact_name AS client,
    project_id, description, version, deleted_at`
  const reminderColumns = `id, enabled, name, payload, cron, schedule_kind, start_at,
    reminder_lead_minutes, channels, delivery_targets`
  return {
    async findOwnedActiveEvent(eventId) {
      return findCalendarEventByOwner(client, ownerId, eventId)
    },

    async projectExistsForOwner(projectId) {
      return isProjectOwnedAndActive(client, ownerId, projectId)
    },

    async listOwnedEventReminders(eventId) {
      const result = await client.query<DatabaseRow>(
        `SELECT ${reminderColumns} FROM scheduled_tasks
         WHERE user_id = $1 AND event_id = $2 ORDER BY id`,
        [ownerId, eventId],
      )
      return result.rows.map(reminderRecord)
    },

    async updateEventIfVersion(eventId, version, fields: CalendarEventUpdateFields) {
      const columns: Record<keyof CalendarEventUpdateFields, string> = {
        title: 'title', date: 'date', time: 'time', end_time: 'end_time',
        type: 'type', client: 'contact_name', project_id: 'project_id', description: 'description',
      }
      const values: unknown[] = [eventId, ownerId, version]
      const assignments = ['version = version + 1']
      for (const [field, value] of Object.entries(fields) as Array<[keyof CalendarEventUpdateFields, unknown]>) {
        const column = columns[field]
        if (!column) throw new Error('Unsupported calendar event update field')
        values.push(value)
        assignments.push(`${column} = $${values.length}`)
      }
      const result = await client.query<DatabaseRow>(
        `UPDATE calendar_events SET ${assignments.join(', ')}
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL AND version = $3
         RETURNING ${eventColumns}`,
        values,
      )
      const row = result.rows[0]
      return row ? calendarEventRecord(row, Number(row.version || 1)) : null
    },

    async stageReminderCron(taskId, cron) {
      const result = await client.query(
        `UPDATE scheduled_tasks SET cron = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND user_id = $2`,
        [taskId, ownerId, cron],
      )
      if (result.rowCount !== 1) throw new Error('Calendar reminder disappeared during update')
    },

    async updateReminder(
      taskId: number,
      update: { name: string; payload: string; schedule?: EventUpdateReminderSchedule },
    ) {
      const schedule = update.schedule
      const result = await client.query(
        `UPDATE scheduled_tasks SET
           name = $3, payload = $4,
           schedule_kind = COALESCE($5, schedule_kind),
           cron = COALESCE($6, cron),
           start_at = COALESCE($7, start_at),
           reminder_lead_minutes = COALESCE($8, reminder_lead_minutes),
           channels = COALESCE($9, channels),
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND user_id = $2`,
        [
          taskId, ownerId, update.name, update.payload,
          schedule?.scheduleKind ?? null, schedule?.cron ?? null,
          schedule?.startAt ?? null, schedule?.reminderLeadMinutes ?? null,
          schedule?.channels ?? null,
        ],
      )
      if (result.rowCount !== 1) throw new Error('Calendar reminder disappeared during update')
    },

    async recordUndo(record) {
      await recordForwardUndoOperation(client, { ...record, userId: ownerId })
    },
  }
}

export function createPostgresEventUpdateStore(
  pool: Pool,
  publish: EventUpdatePublisher,
  reportPublicationFailure: PublicationFailureReporter = (operation) => {
    console.error(`gugu-webui ${operation} failed`)
  },
): EventUpdateStore {
  return {
    async transaction<T>(ownerId: string, work: (tx: EventUpdateTransaction) => Promise<T>): Promise<T> {
      return withPostgresTransaction(pool, (client) => work(transactionAdapter(client, ownerId)))
    },

    async publishCalendarEvent(publication) {
      try {
        await publish(publication)
      } catch {
        try {
          reportPublicationFailure('calendar event notification')
        } catch {
          // Notification failures must not change the committed PATCH result.
        }
      }
    },
  }
}
