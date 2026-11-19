import { Kysely, PostgresDialect, sql } from 'kysely'
import type { Pool, PoolClient } from 'pg'
import { withBorrowedAgentPostgres } from '../../data/borrowed-postgres.js'
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
