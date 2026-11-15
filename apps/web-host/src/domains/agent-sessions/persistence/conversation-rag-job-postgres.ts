import type { PoolClient } from 'pg'

/**
 * 会话历史在业务事务内变化时，排入 owner 级全量重建。
 * 会话文档是跨 session 的派生投影；空 source_id 让 Worker 读取该 owner 的完整来源，
 * 可合并同一事务中新增的多条消息，也不会把 message id 误当作 source document id。
 */
export async function enqueueConversationRagRebuild(client: PoolClient, ownerId: string): Promise<void> {
  if (!ownerId.trim()) throw new TypeError('会话索引归属无效')
  await client.query(
    `INSERT INTO rag_index_jobs (
       user_id, source_type, source_id, version, operation, status,
       generation, completed_generation, attempts, next_attempt_at,
       lease_until, last_started_at, last_succeeded_at, last_error_code,
       pending_source_ids, created_at, updated_at
     ) VALUES (
       $1, 'conversation', '', '', 'refresh', 'queued',
       1, 0, 0, CURRENT_TIMESTAMP,
       NULL, NULL, NULL, NULL, '[]'::json,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     )
     ON CONFLICT (user_id, source_type) DO UPDATE SET
       source_id = '',
       version = '',
       operation = 'refresh',
       status = 'queued',
       generation = rag_index_jobs.generation + 1,
       next_attempt_at = CURRENT_TIMESTAMP,
       lease_until = NULL,
       last_error_code = NULL,
       pending_source_ids = '[]'::json,
       updated_at = CURRENT_TIMESTAMP`,
    [ownerId],
  )
}
