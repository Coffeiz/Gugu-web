import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type {
  CalendarEventDeletePublication,
  CalendarEventDeleteRecord,
  CalendarEventDeleteStore,
  CalendarEventDeleteTransaction,
  CalendarEventDeleteUndoRecord,
  CalendarEventReminderRecord,
} from '../application/event-delete.js'

type DatabaseRow = Record<string, unknown>
type CalendarEventDeletePublisher = (publication: CalendarEventDeletePublication) => Promise<unknown>
type PublicationFailureReporter = (operation: string) => void

function timestamp(value: unknown): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

function eventRecord(row: DatabaseRow): CalendarEventDeleteRecord {
  return {
    id: Number(row.id),
    title: String(row.title),
    date: String(row.date),
    time: row.time == null ? null : String(row.time),
    end_time: row.end_time == null ? null : String(row.end_time),
    type: String(row.type),
    client: row.client == null ? null : String(row.client),
    project_id: row.project_id == null ? null : Number(row.project_id),
    description: row.description == null ? null : String(row.description),
    version: Number(row.version || 1),
    deleted_at: timestamp(row.deleted_at),
  }
}

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

function newUndoId(prefix: 'op' | 'group'): string {
  return `${prefix}-${randomUUID().replaceAll('-', '')}`
}

async function insertUndo(
  client: PoolClient,
  ownerId: string,
  record: CalendarEventDeleteUndoRecord,
): Promise<void> {
  // Match UndoService.record_forward: expire this web context's redo branch in the same transaction.
  await client.query(
    `UPDATE undo_operations
     SET status = 'expired', failure_code = 'redo_cleared_by_new_operation'
     WHERE user_id = $1 AND undo_context_id = $2
       AND actor_type = 'web' AND status = 'undone'`,
    [ownerId, record.contextId],
  )
  await client.query(
    `INSERT INTO undo_operations (
       id, user_id, undo_context_id, group_id, resource, action,
       target_refs, before_state, after_state, base_versions, artifact_refs,
       actor_type, status, created_at, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7::json, $8::json, $9::json, $10::json, '{}'::json,
       'web', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days'
     )`,
    [
      newUndoId('op'), ownerId, record.contextId, newUndoId('group'),
      record.resource, record.action, JSON.stringify(record.targetRefs),
      JSON.stringify(record.beforeState), JSON.stringify(record.afterState),
      JSON.stringify(record.baseVersions),
    ],
  )
}

function transactionAdapter(client: PoolClient, ownerId: string): CalendarEventDeleteTransaction {
  const eventFields = `id, title, date, time, end_time, type, contact_name AS client,
    project_id, description, version, deleted_at`
  return {
    async findOwnedActiveEvent(eventId) {
      const result = await client.query<DatabaseRow>(
        `SELECT ${eventFields} FROM calendar_events
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [eventId, ownerId],
      )
      const row = result.rows[0]
      return row ? eventRecord(row) : null
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
      return row ? eventRecord(row) : null
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
      await insertUndo(client, ownerId, record)
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
      const client = await pool.connect()
      let released = false
      try {
        await client.query('BEGIN')
        try {
          const result = await work(transactionAdapter(client, ownerId))
          await client.query('COMMIT')
          return result
        } catch (error) {
          try {
            await client.query('ROLLBACK')
          } catch {
            client.release(true)
            released = true
            throw error
          }
          throw error
        }
      } finally {
        if (!released) client.release()
      }
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
