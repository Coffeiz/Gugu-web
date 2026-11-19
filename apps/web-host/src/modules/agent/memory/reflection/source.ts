import { sql, type Transaction } from 'kysely'
import type { Database } from '@gugu/core/data'
import type { Pool } from 'pg'
import type { OwnerReflectionBatch } from './write.js'

type Anchor = { userMessageId: string; runId: string }
type SessionState = { execution_state: string; pending_message_count: number; active_run_id: string | null }
const canRead = (state: SessionState) => state.execution_state === 'idle'
  && state.pending_message_count === 0 && state.active_run_id === null

/** FS 写入和索引更新持有会话行锁，避免发布时与新的活动 Run 交错。 */
export async function authorizeOwnerReflectionWrite(tx: Transaction<Database>, batch: OwnerReflectionBatch, signal: AbortSignal) {
  signal.throwIfAborted()
  const { rows } = await sql<SessionState>`SELECT s.execution_state,s.pending_message_count,s.active_run_id
    FROM conversation_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.id=${batch.sessionId} AND s.user_id=${batch.ownerId} AND s.source='web'
      AND (s.chat_type IS NULL OR s.chat_type='private')
      AND u.is_active IS TRUE AND coalesce(u.account_status,'active')='active'
    FOR NO KEY UPDATE OF s`.execute(tx)
  signal.throwIfAborted()
  return !!rows[0] && canRead(rows[0])
}

/** Redis 只提供定位符。每次从同一 PostgreSQL 快照重读授权会话和已提交回合。 */
export function createPostgresOwnerReflectionSource(pool: Pick<Pool, 'query'>) {
  return async function read(batch: Pick<OwnerReflectionBatch, 'ownerId' | 'sessionId'> & {
    turns: readonly Anchor[]
  }, signal: AbortSignal) {
    signal.throwIfAborted()
    if (batch.turns.length < 1 || batch.turns.length > 100) return { kind: 'discard' } as const
    // 删除或清理一个回合时保留同批的其他证据，由队列缩短队首再验证。
    const missingTurn = { kind: batch.turns.length > 1 ? 'split' : 'discard' } as const
    if (batch.turns.some(turn => !/^[1-9]\d*$/u.test(turn.userMessageId)
      || !Number.isSafeInteger(Number(turn.userMessageId)) || !turn.runId)) return missingTurn
    const result = await pool.query<SessionState & {
      user_name: string; timezone: string | null; user_message: string | null
      assistant_reply: string | null; happened_at: Date | null
    }>(`SELECT s.execution_state,s.pending_message_count,s.active_run_id,
        coalesce(nullif(btrim(u.display_name),''),u.username) AS user_name,u.timezone,
        CASE WHEN char_length(m.content)<=64000 THEN m.content END AS user_message,
        CASE WHEN char_length(a.content)<=64000 THEN a.content END AS assistant_reply,
        m.created_at AS happened_at
      FROM conversation_sessions s JOIN users u ON u.id=s.user_id
      CROSS JOIN unnest($3::bigint[], $4::text[]) WITH ORDINALITY AS selected(message_id,run_id,ord)
      LEFT JOIN conversation_messages m ON m.session_id=s.id AND m.id=selected.message_id
        AND m.run_id=selected.run_id AND m.role='user'
      LEFT JOIN LATERAL (
        SELECT reply.content FROM conversation_messages reply
        WHERE reply.session_id=s.id AND reply.run_id=selected.run_id AND reply.role='assistant'
          AND reply.canonical_batch_id IS NULL AND reply.conversation_seq>m.conversation_seq
        ORDER BY reply.conversation_seq DESC LIMIT 1
      ) a ON TRUE
      WHERE s.id=$2 AND s.user_id=$1 AND s.source='web'
        AND (s.chat_type IS NULL OR s.chat_type='private')
        AND u.is_active IS TRUE AND coalesce(u.account_status,'active')='active'
      ORDER BY selected.ord`,
    [batch.ownerId, batch.sessionId, batch.turns.map(turn => turn.userMessageId), batch.turns.map(turn => turn.runId)])
    signal.throwIfAborted()
    const first = result.rows[0]
    if (!first) return { kind: 'discard' } as const
    if (!canRead(first)) return { kind: 'defer' } as const
    if (result.rows.length !== batch.turns.length) return missingTurn
    const turns = []
    for (const row of result.rows) {
      if (typeof row.user_message !== 'string' || !row.assistant_reply?.trim() || !row.happened_at)
        return missingTurn
      turns.push({ userMessage: row.user_message, assistantReply: row.assistant_reply, timestamp: row.happened_at.toISOString() })
    }
    return { kind: 'ready', userName: first.user_name, timezone: first.timezone, turns } as const
  }
}
