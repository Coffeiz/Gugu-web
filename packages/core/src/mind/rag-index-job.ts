import { sql, type Kysely, type Transaction } from 'kysely'
import { databaseTime } from '../data/codec.js'
import type { Backend } from '../data/repositories.js'

/** 把 Mind 投影变更写入持久 RAG 队列；调用方必须传入业务事务。 */
export async function enqueueMindRagIndex<DB>(
  tx: Kysely<DB> | Transaction<DB>, backend: Backend, owner: string,
  sourceType: 'note' | 'canvas', sourceId: string, timestamp: unknown,
  operation: 'create' | 'update' | 'delete',
): Promise<void> {
  const dueAt = databaseTime(String(timestamp), backend)
  if (backend === 'postgres') {
    await sql`INSERT INTO rag_index_jobs(user_id,source_type,source_id,version,operation,status,generation,completed_generation,attempts,next_attempt_at,lease_until,last_started_at,last_succeeded_at,last_error_code,pending_source_ids,created_at,updated_at)
      VALUES(${owner},${sourceType},${sourceId},'',${operation},'queued',1,0,0,CURRENT_TIMESTAMP,NULL,NULL,NULL,NULL,json_build_array(${sourceId}::varchar),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      ON CONFLICT(user_id,source_type) DO UPDATE SET source_id=EXCLUDED.source_id,version='',operation=EXCLUDED.operation,status='queued',generation=rag_index_jobs.generation+1,next_attempt_at=CURRENT_TIMESTAMP,lease_until=NULL,last_error_code=NULL,pending_source_ids=(SELECT COALESCE(json_agg(x.id ORDER BY x.ord),'[]'::json) FROM (SELECT id,MIN(ord) ord FROM (SELECT value id,ordinality ord FROM jsonb_array_elements_text(COALESCE(rag_index_jobs.pending_source_ids::jsonb,'[]'::jsonb)) WITH ORDINALITY UNION ALL SELECT EXCLUDED.source_id,2147483647) a GROUP BY id) x),updated_at=CURRENT_TIMESTAMP`.execute(tx)
    return
  }
  await sql`INSERT INTO rag_index_jobs(user_id,source_type,source_id,version,operation,status,generation,completed_generation,attempts,next_attempt_at,lease_until,last_started_at,last_succeeded_at,last_error_code,pending_source_ids,created_at,updated_at)
    VALUES(${owner},${sourceType},${sourceId},'',${operation},'queued',1,0,0,${dueAt},NULL,NULL,NULL,NULL,json_array(${sourceId}),${dueAt},${dueAt})
    ON CONFLICT(user_id,source_type) DO UPDATE SET source_id=excluded.source_id,version='',operation=excluded.operation,status='queued',generation=rag_index_jobs.generation+1,next_attempt_at=${dueAt},lease_until=NULL,last_error_code=NULL,pending_source_ids=(SELECT json_group_array(value) FROM (SELECT value,MIN(ord) AS first_ord FROM (SELECT value,CAST(key AS INTEGER) AS ord FROM json_each(COALESCE(rag_index_jobs.pending_source_ids,'[]')) UNION ALL SELECT excluded.source_id,2147483647) GROUP BY value ORDER BY first_ord)),updated_at=${dueAt}`.execute(tx)
}
