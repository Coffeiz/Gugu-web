import { Kysely, PostgresDialect, sql } from 'kysely'
import type { Pool } from 'pg'
import { dataContext } from '../../contracts/index.js'
import type { AgentSessionDeleteRepository } from './delete.js'

/** PostgreSQL session deletion. The row lock fences concurrent message inserts until all children are removed. */
export function createPostgresAgentSessionDeleteRepository(pool: Pick<Pool, 'query' | 'connect'>): AgentSessionDeleteRepository {
  const db = new Kysely<any>({ dialect: new PostgresDialect({ pool: pool as Pool }) })
  return {
    async delete(rawOwnerId, sessionId) {
      const ownerId = dataContext(rawOwnerId).ownerId
      return db.transaction().execute(async tx => {
        const session = (await sql`SELECT id FROM conversation_sessions WHERE user_id=${ownerId} AND id=${sessionId} FOR UPDATE`.execute(tx)).rows[0]
        if (!session) return null

        const rows = await sql<{ storage_key: string }>`
          SELECT DISTINCT a.storage_key
          FROM chat_attachments a
          JOIN conversation_messages m ON m.id=a.message_id
          WHERE a.user_id=${ownerId} AND m.session_id=${sessionId}
        `.execute(tx)
        const storageKeys = rows.rows.map(row => row.storage_key)

        await sql`
          UPDATE terminal_sessions
          SET status='terminated', closed_at=clock_timestamp(), updated_at=clock_timestamp()
          WHERE session_id=${sessionId} AND source='agent' AND closed_at IS NULL
        `.execute(tx)
        await sql`
          DELETE FROM chat_attachments
          WHERE user_id=${ownerId} AND message_id IN (
            SELECT id FROM conversation_messages WHERE session_id=${sessionId}
          )
        `.execute(tx)
        await sql`DELETE FROM conversation_messages WHERE session_id=${sessionId}`.execute(tx)
        await sql`DELETE FROM conversation_sessions WHERE id=${sessionId} AND user_id=${ownerId}`.execute(tx)
        return { storageKeys }
      })
    },
  }
}
