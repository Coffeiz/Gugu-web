import { sql, type Kysely, type Transaction } from 'kysely'

/** 将定时任务来源变更并入主数据事务，并合并待处理 source ID。 */
export async function enqueueScheduledTaskRagIndex<DB>(
  tx: Kysely<DB> | Transaction<DB>, backend: 'sqlite' | 'postgres', owner: string, taskId: number,
  timestamp: ReturnType<typeof sql> = sql`CURRENT_TIMESTAMP`,
): Promise<void> {
  if (!Number.isSafeInteger(taskId) || taskId < 1) throw new TypeError('RAG 定时任务标识无效')
  const sourceId = String(taskId)
  if (backend === 'postgres') {
    await sql`INSERT INTO rag_index_jobs(user_id,source_type,source_id,version,operation,status,generation,completed_generation,attempts,next_attempt_at,lease_until,last_started_at,last_succeeded_at,last_error_code,pending_source_ids,created_at,updated_at)
      VALUES(${owner},'scheduled_task',${sourceId},'','upsert','queued',1,0,0,CURRENT_TIMESTAMP,NULL,NULL,NULL,NULL,json_build_array(${sourceId}::varchar),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      ON CONFLICT(user_id,source_type) DO UPDATE SET
       source_id=CASE WHEN rag_index_jobs.source_id='' THEN '' ELSE EXCLUDED.source_id END,
       version='',operation='upsert',status='queued',generation=rag_index_jobs.generation+1,next_attempt_at=CURRENT_TIMESTAMP,lease_until=NULL,last_error_code=NULL,
       pending_source_ids=CASE WHEN rag_index_jobs.source_id='' THEN '[]'::json ELSE (
        SELECT COALESCE(json_agg(x.id ORDER BY x.ord),'[]'::json) FROM (
         SELECT id,MIN(ord) ord FROM (
          SELECT value id,ordinality ord FROM jsonb_array_elements_text(COALESCE(rag_index_jobs.pending_source_ids::jsonb,'[]'::jsonb)) WITH ORDINALITY
          UNION ALL SELECT rag_index_jobs.source_id,2147483646 WHERE rag_index_jobs.source_id<>''
          UNION ALL SELECT EXCLUDED.source_id,2147483647
         ) a GROUP BY id
        ) x
       ) END,
       updated_at=CURRENT_TIMESTAMP`.execute(tx)
    return
  }
  await sql`INSERT INTO rag_index_jobs(user_id,source_type,source_id,version,operation,status,generation,completed_generation,attempts,next_attempt_at,lease_until,last_started_at,last_succeeded_at,last_error_code,pending_source_ids,created_at,updated_at)
    VALUES(${owner},'scheduled_task',${sourceId},'','upsert','queued',1,0,0,${timestamp},NULL,NULL,NULL,NULL,json_array(${sourceId}),${timestamp},${timestamp})
    ON CONFLICT(user_id,source_type) DO UPDATE SET
      source_id=CASE WHEN rag_index_jobs.source_id='' THEN '' ELSE excluded.source_id END,
      version='',operation='upsert',status='queued',generation=rag_index_jobs.generation+1,next_attempt_at=${timestamp},lease_until=NULL,last_error_code=NULL,
      pending_source_ids=CASE WHEN rag_index_jobs.source_id='' THEN '[]' ELSE (
        SELECT json_group_array(value) FROM (
          SELECT value,MIN(ord) AS first_ord FROM (
            SELECT value,CAST(key AS INTEGER) AS ord FROM json_each(COALESCE(rag_index_jobs.pending_source_ids,'[]'))
            UNION ALL SELECT rag_index_jobs.source_id,2147483646 WHERE rag_index_jobs.source_id<>''
            UNION ALL SELECT excluded.source_id,2147483647
          ) GROUP BY value ORDER BY first_ord
        )
      ) END,
      updated_at=${timestamp}`.execute(tx)
}
