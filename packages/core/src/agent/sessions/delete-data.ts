import { Kysely, PostgresDialect, sql } from 'kysely'
import type { Pool, PoolClient } from 'pg'
import { withBorrowedAgentPostgres } from '../../data/borrowed-postgres.js'
import type { Database } from '../../data/schema.js'
import { dataContext } from '../../contracts/index.js'
import type { AgentSessionDeleteRepository } from './delete.js'
import { enqueueAgentRagRebuildInTransaction } from '../rag/rebuild-worker.js'

/** PostgreSQL session deletion. The row lock fences concurrent message inserts until all children are removed. */
export function createPostgresAgentSessionDeleteRepository(pool: Pick<Pool, 'query' | 'connect'>): AgentSessionDeleteRepository {
  const db = new Kysely<any>({ dialect: new PostgresDialect({ pool: pool as Pool }) })
  return {
    async delete(rawOwnerId, sessionId) {
      return db.transaction().execute(tx => deleteSession(tx, rawOwnerId, sessionId))
    },
  }
}

export function deleteAgentSessionLocked(client: PoolClient, ownerId: string, sessionId: number) {
  return withBorrowedAgentPostgres(client, db => deleteSession(db, ownerId, sessionId))
}

async function deleteSession(tx: Kysely<any>, rawOwnerId: string, sessionId: number) {
  const ownerId = dataContext(rawOwnerId).ownerId
  const session = (await sql`SELECT id FROM conversation_sessions WHERE user_id=${ownerId} AND id=${sessionId} FOR UPDATE`.execute(tx)).rows[0]
  if (!session) return null

  const rows = await sql<{ storage_key: string }>`
    SELECT DISTINCT a.storage_key
    FROM chat_attachments a
    JOIN conversation_messages m ON m.id=a.message_id
    WHERE a.user_id=${ownerId} AND m.session_id=${sessionId}
    ORDER BY a.storage_key
  `.execute(tx)
  const storageKeys = rows.rows.map(row => row.storage_key)

  // 终端与派生索引按 Node Host 能力分别安装。
  const capabilities = (await sql<{ terminals: boolean; ragIndex: boolean }>`
    SELECT to_regclass(format('%I.terminal_sessions',current_schema())) IS NOT NULL AS terminals,
           to_regclass(format('%I.knowledge_index_entries',current_schema())) IS NOT NULL AS "ragIndex"
  `.execute(tx)).rows[0]!
  if (capabilities.terminals) {
    await sql`
      UPDATE terminal_sessions
      SET status='terminated', closed_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE owner_id=${ownerId} AND session_id=${sessionId} AND source='agent' AND closed_at IS NULL
    `.execute(tx)
  }
  // 推进代数后再撤下文档，已领取旧代数的 Worker 无法重新发布。
  await enqueueAgentRagRebuildInTransaction(tx, 'postgres', ownerId, 'conversation')
  if (capabilities.ragIndex) {
    await sql`
      UPDATE knowledge_index_entries
      SET deleted_at=coalesce(deleted_at,clock_timestamp()), indexed_at=clock_timestamp(),
          title='', summary='', content='', content_hash='', metadata_json='{}'::json
      WHERE owner_user_id=${ownerId} AND source_type='conversation'
        AND metadata_json->>'session_id'=${String(sessionId)}
    `.execute(tx)
  }
  await sql`
    DELETE FROM chat_attachments
    WHERE user_id=${ownerId} AND message_id IN (
      SELECT id FROM conversation_messages WHERE session_id=${sessionId}
    )
  `.execute(tx)
  await sql`DELETE FROM conversation_messages WHERE session_id=${sessionId}`.execute(tx)
  await sql`DELETE FROM conversation_sessions WHERE id=${sessionId} AND user_id=${ownerId}`.execute(tx)
  return { storageKeys }
}

export function resetPostgresImSessionLocked(client: PoolClient, ownerId: string, sessionId: number) {
  return withBorrowedAgentPostgres(client, db => resetAgentSessionContext(db, 'postgres', ownerId, sessionId))
}

/** 调用方须先在同一事务确认 IM 会话归属。保留会话标识、授权和工作区绑定。 */
export async function resetAgentSessionContext(tx: Kysely<Database>, backend: 'postgres' | 'sqlite', rawOwnerId: string, sessionId: number) {
  const canonical = dataContext(rawOwnerId).ownerId
  const owner = backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical
  const scope = sql`user_id=${owner} AND id=${sessionId}`
  const context = backend === 'sqlite'
    ? sql`CASE WHEN json_valid(session_context) AND json_type(session_context,'$.workspace_binding')='object'
      THEN json_object('workspace_binding',json_extract(session_context,'$.workspace_binding')) ELSE NULL END`
    : sql`NULL`
  const { rows } = await sql`UPDATE conversation_sessions SET summary='', session_context=${context},
    session_info_hash=NULL, snapshot_hash=NULL, snapshot_expires_at=NULL, context_epoch=context_epoch+1,
    baseline_message_seq=0, baseline_message_hash=NULL, history_provider=NULL, history_api_format=NULL,
    updated_at=CURRENT_TIMESTAMP WHERE ${scope} AND active_run_id IS NULL AND execution_state='idle'
      AND pending_message_count=0 RETURNING id`.execute(tx)
  if (!rows.length) return null
  const { rows: files } = await sql<{ storage_key: string }>`DELETE FROM chat_attachments
    WHERE user_id=${owner} AND message_id IN (SELECT id FROM conversation_messages WHERE session_id=${sessionId})
    RETURNING storage_key`.execute(tx)
  await sql`DELETE FROM interaction_prompts WHERE user_id=${owner} AND session_id=${sessionId}`.execute(tx)
  await sql`DELETE FROM agent_run_checkpoints WHERE user_id=${owner} AND session_id=${sessionId}`.execute(tx)
  await sql`DELETE FROM conversation_messages WHERE session_id=${sessionId}`.execute(tx)
  await enqueueAgentRagRebuildInTransaction(tx, backend, canonical, 'conversation')
  const indexSession = backend === 'sqlite' ? sql`json_extract(metadata_json,'$.session_id')` : sql`metadata_json->>'session_id'`
  await sql`UPDATE knowledge_index_entries SET deleted_at=CURRENT_TIMESTAMP,indexed_at=CURRENT_TIMESTAMP,
    title='',summary='',content='',content_hash='',metadata_json='{}'
    WHERE owner_user_id=${owner} AND source_type='conversation' AND CAST(${indexSession} AS TEXT)=${String(sessionId)}`.execute(tx)
  return files.map(file => file.storage_key)
}
