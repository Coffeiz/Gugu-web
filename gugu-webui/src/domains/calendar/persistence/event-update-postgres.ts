import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type {
  CalendarEventUpdateFields,
  CalendarEventUpdateRecord,
  EventUpdatePublication,
  EventUpdateReminderRecord,
  EventUpdateReminderSchedule,
  EventUpdateStore,
  EventUpdateTransaction,
  EventUpdateUndoRecord,
} from '../application/event-update.js'

type DatabaseRow = Record<string, unknown>
type EventUpdatePublisher = (publication: EventUpdatePublication) => Promise<unknown>
type PublicationFailureReporter = (operation: string) => void

function timestamp(value: unknown): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

function eventRecord(row: DatabaseRow): CalendarEventUpdateRecord {
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

function newUndoId(prefix: 'op' | 'group'): string {
  return `${prefix}-${randomUUID().replaceAll('-', '')}`
}

async function insertUndo(
  client: PoolClient,
  ownerId: string,
  record: EventUpdateUndoRecord,
): Promise<void> {
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

function transactionAdapter(client: PoolClient, ownerId: string): EventUpdateTransaction {
  const eventColumns = `id, title, date, time, end_time, type, contact_name AS client,
    project_id, description, version, deleted_at`
  const reminderColumns = `id, enabled, name, payload, cron, schedule_kind, start_at,
    reminder_lead_minutes, channels, delivery_targets`
  return {
    async findOwnedActiveEvent(eventId) {
      const result = await client.query<DatabaseRow>(
        `SELECT ${eventColumns} FROM calendar_events
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [eventId, ownerId],
      )
      const row = result.rows[0]
      return row ? eventRecord(row) : null
    },

    async projectExistsForOwner(projectId) {
      const result = await client.query(
        `SELECT 1 FROM projects WHERE id = $1 AND user_id = $2
         AND deleted_at IS NULL LIMIT 1`,
        [projectId, ownerId],
      )
      return result.rowCount === 1
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
      return row ? eventRecord(row) : null
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
      await insertUndo(client, ownerId, record)
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
