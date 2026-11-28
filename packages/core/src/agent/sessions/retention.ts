import { sql, type Kysely } from 'kysely'
import { dataContext } from '../../contracts/index.js'
import { integer } from '../../data/codec.js'

const retain = 2000
const batchSize = 500
const pendingRunPrefix = 'im-pending:'

/** 分批裁剪摘要覆盖范围内的历史，每批提交后才尝试回收不再被引用的附件。 */
export function createSqlConversationHistoryTrimmer<DB>(db: Kysely<DB>, backend: 'postgres' | 'sqlite',
  removeUnreferenced?: (ownerId: string, storageKey: string) => Promise<boolean>) {
  return async (rawOwnerId: string, sessionId: number): Promise<void> => {
    const owner = dataContext(rawOwnerId).ownerId
    const storedOwner = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new TypeError('会话 ID 无效')
    let started = false
    for (;;) {
      const keys = await db.transaction().execute(async tx => {
        // 与 Run 获取会话执行状态及消息写入使用同一行锁。运行中的会话留给下次清理。
        const session = (await sql<{ baseline_message_seq: number | string }>`
          SELECT baseline_message_seq FROM conversation_sessions
          WHERE id=${sessionId} AND user_id=${storedOwner} AND execution_state='idle' AND active_run_id IS NULL
          ${backend === 'postgres' ? sql`FOR UPDATE` : sql``}`.execute(tx)).rows[0]
        if (!session) return null
        if (!started && !(await sql`SELECT 1 FROM conversation_messages WHERE session_id=${sessionId}
          ORDER BY conversation_seq LIMIT 1 OFFSET ${retain}`.execute(tx)).rows.length) return null

        const summary = (await sql<{ covers_until_seq: number | string | null }>`
          SELECT covers_until_seq FROM conversation_messages WHERE session_id=${sessionId} AND role='summary'
          ORDER BY conversation_seq DESC LIMIT 1`.execute(tx)).rows[0]
        if (!summary) return null
        const baseline = integer(summary.covers_until_seq ?? 0) || integer(session.baseline_message_seq)
        if (baseline <= 0) return null

        const order = sql`COALESCE(history_anchor_seq,conversation_seq)`
        const { rows } = await sql<{ id: number }>`SELECT id FROM conversation_messages
          WHERE session_id=${sessionId} AND ${order}<=${baseline} AND role<>'summary'
            AND (run_id IS NULL OR run_id NOT LIKE ${pendingRunPrefix + '%'})
            AND id NOT IN (SELECT id FROM conversation_messages WHERE session_id=${sessionId}
              ORDER BY ${order} DESC,conversation_seq DESC LIMIT ${retain})
          ORDER BY ${order},CASE WHEN history_anchor_seq IS NOT NULL THEN 0 ELSE 1 END,conversation_seq
          LIMIT ${batchSize}`.execute(tx)
        if (!rows.length) {
          await sql`DELETE FROM interaction_prompts
            WHERE session_id=${sessionId} AND user_id=${storedOwner} AND status IN ('resolved','expired','cancelled')
              AND created_at < (SELECT min(created_at) FROM conversation_messages
                WHERE session_id=${sessionId} AND role<>'summary')`.execute(tx)
          return null
        }
        const ids = sql.join(rows.map(row => row.id))
        // SQLite 的正式会话 schema 没有聊天附件持久表。
        const removedAttachments = backend === 'postgres' ? (await sql<{ storage_key: string }>`
          DELETE FROM chat_attachments WHERE user_id=${storedOwner} AND message_id IN (${ids})
          RETURNING storage_key`.execute(tx)).rows : []
        await sql`DELETE FROM conversation_messages WHERE session_id=${sessionId} AND id IN (${ids})`.execute(tx)
        return [...new Set(removedAttachments.map(row => row.storage_key))]
      })
      if (keys === null) return
      started = true
      if (removeUnreferenced) for (const key of keys) {
        try { await removeUnreferenced(owner, key) } catch { /* 字节回收失败不影响已提交的消息清理。 */ }
      }
    }
  }
}
