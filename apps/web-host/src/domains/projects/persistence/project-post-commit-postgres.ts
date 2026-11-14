import type { Pool } from 'pg'
import { runBestEffort } from '../../../adapters/best-effort.js'

export type ProjectPostCommitResource = 'projects' | 'files' | 'calendar' | 'scheduled_tasks'
export type ProjectPostCommitOperation = 'create' | 'update' | 'delete'

export interface ProjectPostCommitPublication {
  userId: string
  resource: ProjectPostCommitResource
  operation: ProjectPostCommitOperation
  entityId?: number
  entityIds?: number[]
  origin: string | null
  payload?: Record<string, unknown>
}

export interface ProjectPostCommitEffects {
  bumpContextRevision(ownerId: string, resource: ProjectPostCommitResource): Promise<unknown>
  publishResourceChanged(publication: ProjectPostCommitPublication): Promise<unknown>
}

export type ProjectPostCommitFailureReporter = (operation: string, errorCode?: string) => void

const ragSourceByResource: Partial<Record<ProjectPostCommitResource, 'project' | 'calendar' | 'scheduled_task'>> = {
  projects: 'project',
  calendar: 'calendar',
  scheduled_tasks: 'scheduled_task',
}

/** 项目 create/update/trash 的 Redis revision、持久 RAG 队列与 live event 提交后处理。 */
export function createProjectPostCommitPublisher(
  pool: Pool,
  effects: ProjectPostCommitEffects,
  reportFailure: ProjectPostCommitFailureReporter = (operation) => {
    console.error(`gugu-webui ${operation} failed`)
  },
): (publication: ProjectPostCommitPublication) => Promise<void> {
  return async (publication) => {
    await runBestEffort('project context revision', () =>
      effects.bumpContextRevision(publication.userId, publication.resource), reportFailure)

    const sourceType = ragSourceByResource[publication.resource]
    const sourceIds = (publication.entityIds ?? (publication.entityId === undefined ? [] : [publication.entityId]))
      .map(String)
      .filter((id) => id.length > 0)
    if (sourceType) {
      for (const sourceId of sourceIds) {
        await runBestEffort('project RAG index enqueue', async () => {
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
            [publication.userId, sourceType, sourceId, publication.operation],
          )
        }, reportFailure)
      }
    }

    await runBestEffort('project resource notification', () =>
      effects.publishResourceChanged(publication), reportFailure)
  }
}
