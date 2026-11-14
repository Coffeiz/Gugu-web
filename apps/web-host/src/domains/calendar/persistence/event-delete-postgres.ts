import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import { recordForwardUndoOperation } from '../../undo/persistence/forward-operation.js'
import { calendarEventRecord } from '../event-projection.js'
import { findOwnedActiveEvent as findCalendarEventByOwner } from './events.js'
import type {
  CalendarEventDeletePublication,
  CalendarEventDeleteStore,
  CalendarEventDeleteTransaction,
  CalendarEventReminderRecord,
} from '../application/event-delete.js'

type DatabaseRow = Record<string, unknown>
type CalendarEventDeletePublisher = (publication: CalendarEventDeletePublication) => Promise<unknown>
type PublicationFailureReporter = (operation: string) => void

function reminderRecord(row: DatabaseRow): CalendarEventReminderRecord {
  return {
    id: Number(row.id),
    enabled: Boolean(row.enabled),
    name: String(row.name),
    payload: String(row.payload ?? ''),
    cron: String(row.cron),
    schedule_kind: String(row.schedule_kind),
    start_at: row.start_at == null ? null : row.start_at instanceof Date ? row.start_at : String(row.start_at),
    reminder_lead_minutes: row.reminder_lead_minutes == null ? null : Number(row.reminder_lead_minutes),
    channels: String(row.channels),
    delivery_targets: row.delivery_targets ?? null,
  }
}

function transactionAdapter(client: PoolClient, ownerId: string): CalendarEventDeleteTransaction {
  const eventFields = `id, title, date, time, end_time, type, contact_name AS client,
    project_id, description, version, deleted_at`
  return {
    async findOwnedActiveEvent(eventId) {
      return findCalendarEventByOwner(client, ownerId, eventId)
    },

    async listOwnedEventReminders(eventId) {
      const result = await client.query<DatabaseRow>(
        `SELECT id, enabled, name, payload, cron, schedule_kind, start_at,
                reminder_lead_minutes, channels, delivery_targets
         FROM scheduled_tasks
         WHERE user_id = $1 AND event_id = $2
         ORDER BY id`,
        [ownerId, eventId],
      )
      return result.rows.map(reminderRecord)
    },

    async softDeleteEventIfVersion(eventId, version) {
      const result = await client.query<DatabaseRow>(
        `UPDATE calendar_events
         SET deleted_at = CURRENT_TIMESTAMP, version = version + 1
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL AND version = $3
         RETURNING ${eventFields}`,
        [eventId, ownerId, version],
      )
      const row = result.rows[0]
      return row ? calendarEventRecord(row, Number(row.version || 1)) : null
    },

    async disableReminders(eventId, taskIds) {
      if (taskIds.length === 0) return
      await client.query(
        `UPDATE scheduled_tasks SET enabled = FALSE
         WHERE user_id = $1 AND event_id = $2 AND id = ANY($3::integer[])`,
        [ownerId, eventId, taskIds],
      )
    },

    async recordUndo(record) {
      await recordForwardUndoOperation(client, { ...record, userId: ownerId })
    },
  }
}

/** PostgreSQL transaction and Python-compatible Undo adapter for event soft deletion. */
export function createPostgresEventDeleteStore(
  pool: Pool,
  publish: CalendarEventDeletePublisher,
  reportPublicationFailure: PublicationFailureReporter = (operation) => {
    console.error(`gugu-webui ${operation} failed`)
  },
): CalendarEventDeleteStore {
  return {
    async transaction<T>(ownerId: string, work: (tx: CalendarEventDeleteTransaction) => Promise<T>): Promise<T> {
      return withPostgresTransaction(pool, (client) => work(transactionAdapter(client, ownerId)))
    },

    async publishResourceChanged(publication) {
      try {
        await publish(publication)
      } catch {
        try {
          reportPublicationFailure(publication.resource === 'calendar'
            ? 'calendar event notification'
            : 'scheduled task notification')
        } catch {
          // Notification diagnostics must not turn a committed delete into an HTTP error.
        }
      }
    },
  }
}
