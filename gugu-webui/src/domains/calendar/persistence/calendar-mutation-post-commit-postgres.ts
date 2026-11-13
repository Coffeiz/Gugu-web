import type { Pool } from 'pg'
import type { CalendarEventDeletePublication } from '../application/event-delete.js'
import type { EventUpdatePublication } from '../application/event-update.js'

export type CalendarMutationPublication = EventUpdatePublication | CalendarEventDeletePublication

export interface CalendarMutationPostCommitEffects {
  bumpContextRevision(ownerId: string): Promise<unknown>
  /** Delegate exactly once to the Host's existing live-event publisher. */
  publishResourceChanged(publication: CalendarMutationPublication): Promise<unknown>
}

export type CalendarMutationPostCommitFailureReporter = (operation: string, errorCode?: string, errorMessage?: string) => void

async function bestEffort(
  operation: string,
  work: () => Promise<unknown>,
  reportFailure: CalendarMutationPostCommitFailureReporter,
): Promise<void> {
  try {
    await work()
  } catch (error) {
    try {
      const code = typeof error === 'object' && error !== null && 'code' in error
        && typeof error.code === 'string' ? error.code : undefined
      reportFailure(operation, code, error instanceof Error ? error.message : undefined)
    } catch {
      // Post-commit diagnostics must not change an already committed mutation.
    }
  }
}

function ragEvent(publication: CalendarMutationPublication): {
  sourceType: 'calendar' | 'scheduled_task'
  sourceIds: string[]
  operation: 'update' | 'delete'
} {
  if (publication.resource === 'calendar') {
    return {
      sourceType: 'calendar',
      sourceIds: [String(publication.entityId)],
      operation: publication.operation,
    }
  }
  return {
    sourceType: 'scheduled_task',
    sourceIds: publication.entityIds.map(String).filter((id) => id.length > 0),
    operation: publication.operation,
  }
}

/**
 * Decorates the existing post-commit live-event callback for calendar PATCH/DELETE.
 * It records the durable RAG work before delegating the live event once, matching
 * app.core.events.publish without taking ownership of its Redis protocol.
 */
export function createCalendarMutationPostCommitPublisher(
  pool: Pool,
  effects: CalendarMutationPostCommitEffects,
  reportFailure: CalendarMutationPostCommitFailureReporter = (operation) => {
    console.error(`gugu-webui ${operation} failed`)
  },
): (publication: CalendarMutationPublication) => Promise<void> {
  return async (publication) => {
    if (publication.resource === 'calendar') {
      await bestEffort('calendar context revision', () =>
        effects.bumpContextRevision(publication.ownerId), reportFailure)
    }

    const rag = ragEvent(publication)
    for (const sourceId of rag.sourceIds) {
      await bestEffort('calendar RAG index enqueue', async () => {
        await pool.query(
          `INSERT INTO rag_index_jobs (
             user_id, source_type, source_id, version, operation, status,
             generation, completed_generation, attempts, next_attempt_at,
             lease_until, last_started_at, last_succeeded_at, last_error_code,
             pending_source_ids, created_at, updated_at
           ) VALUES (
             $1, $2, $3, '', $4, 'queued',
             1, 0, 0, CURRENT_TIMESTAMP,
             NULL, NULL, NULL, NULL,
             json_build_array($3::varchar), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
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
          [publication.ownerId, rag.sourceType, sourceId, rag.operation],
        )
      }, reportFailure)
    }

    await bestEffort('calendar resource notification', () =>
      effects.publishResourceChanged(publication), reportFailure)
  }
}
