import { Kysely, PostgresDialect, sql } from 'kysely'
import type { Pool } from 'pg'
import type { Database } from '../../data/schema.js'

const retainedSubagentsPerSession = 20

export async function cleanupSubagentConversations(db: Kysely<Database>, dialect: 'sqlite' | 'postgres') {
  return db.transaction().execute(async tx => {
    const { rows } = await sql<{ child_session_id: number; current_run_id: string }>`
      WITH ranked AS (
        SELECT c.child_session_id, c.current_run_id,
          row_number() OVER (PARTITION BY c.owner_id, c.parent_session_id
            ORDER BY d.updated_at DESC, c.child_id DESC) AS position
        FROM agent_subagent_conversations c
        JOIN agent_subagent_deliveries d ON d.child_run_id=c.current_run_id
          AND d.owner_id=c.owner_id AND d.parent_session_id=c.parent_session_id
      )
      SELECT c.child_session_id,c.current_run_id
      FROM agent_subagent_conversations c JOIN ranked r USING(child_session_id)
      WHERE r.position > ${retainedSubagentsPerSession} AND c.current_run_id=r.current_run_id
      ORDER BY c.child_session_id
    `.execute(tx)
    let removed = 0
    for (const row of rows) {
      const childSession = String(row.child_session_id)
      // 检查当前执行及历次结果，并锁定子会话映射和会话行，防止并发续跑。
      const { rows: [target] } = await sql<{ owner_id: string; parent_session_id: string; child_id: string }>`
        SELECT c.owner_id,c.parent_session_id,c.child_id
        FROM agent_subagent_conversations c
        JOIN conversation_sessions s ON s.id=c.child_session_id AND CAST(s.user_id AS TEXT)=c.owner_id
        WHERE c.child_session_id=${row.child_session_id} AND c.current_run_id=${row.current_run_id}
          AND s.active_run_id IS NULL AND s.execution_state='idle'
          AND NOT EXISTS (SELECT 1 FROM agent_run_checkpoints child
            WHERE child.session_id=s.id AND child.user_id=s.user_id
              AND child.status NOT IN ('completed','cancelled','failed','unknown'))
          AND NOT EXISTS (SELECT 1 FROM agent_subagent_conversations nested
            WHERE nested.owner_id=c.owner_id AND nested.parent_session_id=${childSession})
          AND NOT EXISTS (SELECT 1 FROM agent_subagent_deliveries d
            WHERE d.owner_id=c.owner_id AND d.parent_session_id=c.parent_session_id AND d.child_id=c.child_id
              AND (d.status IN ('queued','running') OR d.consumed_checkpoint_version IS NULL
                OR EXISTS (SELECT 1 FROM agent_subagent_waits w
                  WHERE w.owner_id=d.owner_id AND w.parent_session_id=d.parent_session_id
                    AND w.parent_run_id=d.parent_run_id AND w.child_id=d.child_id)
                OR EXISTS (SELECT 1 FROM agent_run_checkpoints p
                  WHERE CAST(p.user_id AS TEXT)=d.owner_id AND CAST(p.session_id AS TEXT)=d.parent_session_id
                    AND p.run_id=d.parent_run_id AND p.status NOT IN ('completed','cancelled','failed','unknown'))))
          AND NOT EXISTS (SELECT 1 FROM agent_inbox_messages m WHERE m.owner_id=c.owner_id
            AND (m.sender_session_id=${childSession} OR m.recipient_session_id=${childSession})
            AND m.consumed_checkpoint_version IS NULL)
        ${dialect === 'postgres' ? sql`FOR UPDATE OF c, s SKIP LOCKED` : sql``}
      `.execute(tx)
      if (!target) continue
      await sql`DELETE FROM agent_subagent_deliveries
        WHERE owner_id=${target.owner_id} AND parent_session_id=${target.parent_session_id} AND child_id=${target.child_id}`.execute(tx)
      await sql`DELETE FROM agent_inbox_messages WHERE owner_id=${target.owner_id}
        AND (sender_session_id=${childSession} OR recipient_session_id=${childSession})`.execute(tx)
      await sql`DELETE FROM conversation_sessions WHERE id=${row.child_session_id}
        AND CAST(user_id AS TEXT)=${target.owner_id}`.execute(tx)
      removed++
      if (removed === 100) break
    }
    return removed
  })
}

export function createPostgresSubagentRetention(pool: Pool) {
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
  return () => cleanupSubagentConversations(db, 'postgres')
}
