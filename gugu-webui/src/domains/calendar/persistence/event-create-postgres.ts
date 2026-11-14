import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import { recordForwardUndoOperation } from '../../undo/persistence/forward-operation.js'
import { projectExistsForOwner as isProjectOwnedAndActive } from '../../projects/persistence/projects.js'
import { calendarEventRecord } from '../event-projection.js'
import {
  CalendarEventIdempotencyUniqueViolation,
  type CalendarEventCreateInput,
  type EventCreatePublication,
  type EventCreateStore,
  type EventCreateTransaction,
} from '../application/event-create.js'

type DatabaseRow = Record<string, unknown>
type CalendarEventPublisher = (publication: EventCreatePublication) => Promise<unknown>
type PublicationFailureReporter = (operation: string) => void

function calendarUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && (error as { code?: unknown }).code === '23505'
    && 'constraint' in error
    && (error as { constraint?: unknown }).constraint === 'uq_calendar_events_user_idempotency_key'
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
        event: calendarEventRecord(row, Number(row.version ?? 1)),
      }
    },

    async projectExistsForOwner(projectId) {
      return isProjectOwnedAndActive(client, ownerId, projectId)
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
        const event = calendarEventRecord(row, Number(row.version ?? 1))
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
      await recordForwardUndoOperation(client, { ...record, userId: ownerId })
    },

    async enqueueRagIndex(eventId) {
      await client.query(
        `INSERT INTO rag_index_jobs (
           user_id, source_type, source_id, version, operation, status,
           generation, completed_generation, attempts, next_attempt_at,
           lease_until, last_started_at, last_succeeded_at, last_error_code,
           pending_source_ids, created_at, updated_at
         ) VALUES (
           $1, 'calendar', $2, '', 'create', 'queued',
           1, 0, 0, CURRENT_TIMESTAMP,
           NULL, NULL, NULL, NULL,
           json_build_array($2::varchar), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
         )
         ON CONFLICT (user_id, source_type) DO UPDATE SET
           source_id = EXCLUDED.source_id,
           version = EXCLUDED.version,
           operation = EXCLUDED.operation,
           status = 'queued',
           generation = rag_index_jobs.generation + 1,
           next_attempt_at = CURRENT_TIMESTAMP,
           lease_until = NULL,
           last_error_code = NULL,
           pending_source_ids = (
             SELECT COALESCE(json_agg(ordered.id ORDER BY ordered.first_ordinal), '[]'::json)
             FROM (
               SELECT candidates.id, MIN(candidates.ordinal) AS first_ordinal
               FROM (
                 SELECT value AS id, ordinality AS ordinal
                 FROM jsonb_array_elements_text(
                   COALESCE(rag_index_jobs.pending_source_ids::jsonb, '[]'::jsonb)
                 ) WITH ORDINALITY
                 UNION ALL
                 SELECT EXCLUDED.source_id AS id, 2147483647 AS ordinal
               ) AS candidates
               GROUP BY candidates.id
             ) AS ordered
           ),
           updated_at = CURRENT_TIMESTAMP`,
        [ownerId, String(eventId)],
      )
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
      return withPostgresTransaction(pool, (client) => work(makeTransaction(client, ownerId)))
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
