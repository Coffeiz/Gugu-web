import type { PoolClient } from 'pg'

/** 将定时任务变更与其 RAG 投影任务写入同一领域事务。 */
export async function enqueueScheduledTaskRagRebuild(client: PoolClient, ownerId: string, taskId: number): Promise<void> {
  if (!Number.isSafeInteger(taskId) || taskId < 1) throw new TypeError('RAG 定时任务标识无效')
  const sourceId = String(taskId)
  await client.query(
    `INSERT INTO rag_index_jobs (
       user_id, source_type, source_id, pending_source_ids, version, operation, status,
       generation, completed_generation, attempts, next_attempt_at, lease_until,
       last_error_code, last_started_at, last_succeeded_at, created_at, updated_at
     ) VALUES ($1, 'scheduled_task', $2, json_build_array($2::varchar), '', 'upsert', 'queued', 1, 0, 0,
       CURRENT_TIMESTAMP, NULL, NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, source_type) DO UPDATE SET
       source_id = CASE WHEN rag_index_jobs.source_id = '' THEN '' ELSE EXCLUDED.source_id END,
       version = '', operation = 'upsert', status = 'queued',
       generation = rag_index_jobs.generation + 1,
       next_attempt_at = CURRENT_TIMESTAMP, lease_until = NULL, last_error_code = NULL,
       pending_source_ids = CASE WHEN rag_index_jobs.source_id = '' THEN '[]'::json ELSE (
         SELECT COALESCE(json_agg(item.source_id ORDER BY item.first_position), '[]'::json)
         FROM (
           SELECT source_id, MIN(position) AS first_position
           FROM (
             SELECT value AS source_id, ordinality AS position
             FROM jsonb_array_elements_text(COALESCE(rag_index_jobs.pending_source_ids::jsonb, '[]'::jsonb)) WITH ORDINALITY
             UNION ALL SELECT rag_index_jobs.source_id, 2147483646 WHERE rag_index_jobs.source_id <> ''
             UNION ALL SELECT EXCLUDED.source_id, 2147483647
           ) pending
           GROUP BY source_id
         ) item
       ) END,
       updated_at = CURRENT_TIMESTAMP`,
    [ownerId, sourceId],
  )
}
