import type { Pool } from 'pg'
import type { EventCreatePublication } from '../application/event-create.js'

export interface CalendarCreatePostCommitEffects {
  /** Bump the user's context snapshot revision after the event transaction commits. */
  bumpContextRevision(ownerId: string): Promise<unknown>
  /** Publish the live resource.changed event after the event transaction commits. */
  publishResourceChanged(input: {
    ownerId: string
    resource: 'calendar'
    operation: 'create'
    entityId: number
    origin: string | null
    payload: EventCreatePublication['eventPayload']
  }): Promise<unknown>
}

export type CalendarCreatePostCommitFailureReporter = (operation: string, errorCode?: string, errorMessage?: string) => void

async function bestEffort(
  operation: string,
  work: () => Promise<unknown>,
  reportFailure: CalendarCreatePostCommitFailureReporter,
): Promise<void> {
  try {
    await work()
  } catch (error) {
    try {
      const code = typeof error === 'object' && error !== null && 'code' in error
        && typeof error.code === 'string' ? error.code : undefined
      reportFailure(operation, code, error instanceof Error ? error.message : undefined)
    } catch {
      // Post-commit diagnostics must never change the committed create result.
    }
  }
}

/**
 * Creates post-commit side effects for a committed calendar create.
 *
 * The RAG queue table is owned by Alembic. This adapter only writes its existing
 * durable job contract; the Python recovery/index worker still consumes it.
 */
export function createCalendarEventPostCommitPublisher(
  pool: Pool,
  effects: CalendarCreatePostCommitEffects,
  reportFailure: CalendarCreatePostCommitFailureReporter = (operation) => {
    console.error(`gugu-webui ${operation} failed`)
  },
): (publication: EventCreatePublication) => Promise<void> {
  return async (publication) => {
    await bestEffort('calendar context revision', () =>
      effects.bumpContextRevision(publication.ownerId), reportFailure)

    await bestEffort('calendar RAG index enqueue', async () => {
      await pool.query(
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
        [publication.ownerId, String(publication.entityId)],
      )
    }, reportFailure)

    await bestEffort('calendar resource notification', () =>
      effects.publishResourceChanged({
        ownerId: publication.ownerId,
        resource: 'calendar',
        operation: 'create',
        entityId: publication.entityId,
        origin: publication.origin,
        payload: publication.eventPayload,
      }), reportFailure)
  }
}
