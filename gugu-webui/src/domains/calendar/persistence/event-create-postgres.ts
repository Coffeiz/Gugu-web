import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  CalendarEventIdempotencyUniqueViolation,
  type CalendarEventCreateInput,
  type CalendarEventRecord,
  type CalendarEventUndoRecord,
  type EventCreatePublication,
  type EventCreateStore,
  type EventCreateTransaction,
} from '../application/event-create.js'

type DatabaseRow = Record<string, unknown>
type CalendarEventPublisher = (publication: EventCreatePublication) => Promise<unknown>
type PublicationFailureReporter = (operation: string) => void

function eventRecord(row: DatabaseRow): CalendarEventRecord {
  const deletedAt = row.deleted_at
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
    version: Number(row.version ?? 1),
    deleted_at: deletedAt instanceof Date ? deletedAt.toISOString() : deletedAt == null ? null : String(deletedAt),
  }
}

function calendarUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && (error as { code?: unknown }).code === '23505'
    && 'constraint' in error
    && (error as { constraint?: unknown }).constraint === 'uq_calendar_events_user_idempotency_key'
}

function newUndoId(prefix: 'op' | 'group'): string {
  return `${prefix}-${randomUUID().replaceAll('-', '')}`
}

async function insertUndo(
  client: PoolClient,
  ownerId: string,
  record: CalendarEventUndoRecord,
): Promise<void> {
  // Match UndoService.record_forward: a new forward action invalidates the same
  // web context's redo branch and stores the operation in the business transaction.
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

function makeTransaction(client: PoolClient, ownerId: string): EventCreateTransaction {
  return {
    async findIdempotent(keyHash) {
      const result = await client.query<DatabaseRow>(
        `SELECT id, title, date, time, end_time, type, contact_name AS client,
                project_id, description, version, deleted_at, idempotency_fingerprint
         FROM calendar_events
         WHERE user_id = $1 AND idempotency_key = $2
         LIMIT 1`,
        [ownerId, keyHash],
      )
      const row = result.rows[0]
      if (!row) return null
      return {
        fingerprint: String(row.idempotency_fingerprint ?? ''),
        event: eventRecord(row),
      }
    },

    async projectExistsForOwner(projectId) {
      const result = await client.query(
        `SELECT 1 FROM projects
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [projectId, ownerId],
      )
      return result.rowCount === 1
    },

    async insertWithSavepoint(input: CalendarEventCreateInput, idempotency) {
      await client.query('SAVEPOINT event_create_insert')
      try {
        const result = await client.query<DatabaseRow>(
          `INSERT INTO calendar_events (
             user_id, title, date, time, end_time, type, contact_name,
             project_id, description, version, created_at, idempotency_key,
             idempotency_fingerprint
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1,
                     CURRENT_TIMESTAMP, $10, $11)
           RETURNING id, title, date, time, end_time, type, contact_name AS client,
                     project_id, description, version, deleted_at`,
          [
            ownerId, input.title, input.date, input.time, input.end_time, input.type,
            input.client, input.project_id, input.description,
            idempotency?.keyHash ?? null, idempotency?.fingerprint ?? null,
          ],
        )
        const row = result.rows[0]
        if (!row) throw new Error('Calendar event insert returned no row')
        const event = eventRecord(row)
        await client.query('RELEASE SAVEPOINT event_create_insert')
        return event
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT event_create_insert')
        await client.query('RELEASE SAVEPOINT event_create_insert')
        if (idempotency && calendarUniqueViolation(error))
          throw new CalendarEventIdempotencyUniqueViolation()
        throw error
      }
    },

    async recordUndo(record) {
      await insertUndo(client, ownerId, record)
    },
  }
}

/**
 * PostgreSQL adapter for calendar event creation. The publisher is called only
 * after COMMIT; notification failures are diagnostic-only and never undo a
 * successfully committed event.
 */
export function createPostgresEventCreateStore(
  pool: Pool,
  publish: CalendarEventPublisher,
  reportPublicationFailure: PublicationFailureReporter = (operation) => {
    console.error(`gugu-webui ${operation} failed`)
  },
): EventCreateStore {
  return {
    async transaction<T>(ownerId: string, work: (tx: EventCreateTransaction) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      let released = false
      try {
        await client.query('BEGIN')
        try {
          const result = await work(makeTransaction(client, ownerId))
          await client.query('COMMIT')
          return result
        } catch (error) {
          try {
            await client.query('ROLLBACK')
          } catch {
            // Keep the business error; the connection is discarded if rollback failed.
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
          // Notification diagnostics must not change the committed create result.
        }
      }
    },
  }
}
