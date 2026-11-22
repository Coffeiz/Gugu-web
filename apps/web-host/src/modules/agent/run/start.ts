import { enqueueAgentRunLocked } from './dispatch.js'
import { CompiledQuery, sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '@gugu/core/data'
import type { Pool, PoolClient } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import { withPostgresTransaction } from '../../../adapters/database/postgres-transaction.js'

function parameters(identity: RunIdentity): [string, number, string] {
  const session = Number(identity.sessionId)
  if (!identity.ownerId || !identity.runId || identity.runId.length > 128 || !/^[1-9]\d*$/.test(identity.sessionId) || !Number.isSafeInteger(session)) throw new TypeError('Agent run 身份无效')
  return [identity.ownerId, session, identity.runId]
}
/** 所有启动登记、租约获取、首次 checkpoint 必须先以相同顺序锁住会话。 */
export async function lockAgentRunSession(client: PoolClient, identity: RunIdentity): Promise<boolean> {
  const [owner, session] = parameters(identity)
  const result = await client.query('SELECT id FROM conversation_sessions WHERE user_id = $1 AND id = $2 FOR UPDATE', [owner, session])
  return result.rowCount === 1
}

/** 未登记的历史运行继续允许执行；已判定失败的运行不能重新启动。 */
export async function agentRunStartupFailed(client: PoolClient, identity: RunIdentity): Promise<boolean> {
  const result = await client.query("SELECT 1 FROM agent_run_startups WHERE user_id = $1 AND session_id = $2 AND run_id = $3 AND status = 'failed'", parameters(identity))
  return result.rowCount === 1
}

const registerStartup = `INSERT INTO agent_run_startups (user_id, session_id, run_id, status, created_at, updated_at)
  VALUES ($1, $2, $3, 'pending', clock_timestamp(), clock_timestamp()) ON CONFLICT DO NOTHING`

/** 调用方必须已持有同一会话行锁；登记与用户消息事务一同提交。 */
export async function registerAgentRunStartupLocked(client: PoolClient, identity: RunIdentity): Promise<boolean> {
  const result = await client.query(registerStartup, parameters(identity))
  return result.rowCount === 1
}

/** 委派正文留在加密材料中，仅保存普通 Run 所需的消息锚点。 */
export async function registerWebSubagentStartup(tx: Transaction<Database>, identity: RunIdentity, secret: string): Promise<void> {
  const [owner, session, run] = parameters(identity)
  const { rows: [owned] } = await sql<{ last_message_seq: string }>`
    SELECT last_message_seq FROM conversation_sessions
    WHERE user_id=${owner} AND id=${session} AND source='subagent' FOR UPDATE`.execute(tx)
  if (!owned) throw new Error('子会话无法登记运行')
  const { rows: [existing] } = await sql<{ id: number }>`
    SELECT id FROM conversation_messages WHERE session_id=${session} AND run_id=${run} AND role='user'`.execute(tx)
  let messageId = existing?.id
  if (messageId === undefined) {
    const { rows: [message] } = await sql<{ id: number; conversation_seq: string }>`
      INSERT INTO conversation_messages(session_id,conversation_seq,role,content,run_id)
      VALUES(${session},${owned.last_message_seq}::bigint+1,'user','子 Agent 委派',${run})
      RETURNING id,conversation_seq`.execute(tx)
    if (!message) throw new Error('子会话消息锚点未保存')
    messageId = message.id
    await sql`UPDATE conversation_sessions SET last_message_seq=${message.conversation_seq}
      WHERE user_id=${owner} AND id=${session}`.execute(tx)
  }
  const executor = tx.getExecutor()
  await executor.executeQuery(CompiledQuery.raw(registerStartup, parameters(identity)))
  await enqueueAgentRunLocked({
    async query<T extends Record<string, unknown>>(text: string, values: unknown[]) {
      const result = await executor.executeQuery<T>(CompiledQuery.raw(text, values))
      return { rows: result.rows, rowCount: Number(result.numAffectedRows ?? result.rows.length) }
    },
  }, secret, identity, { v: 2, source: 'web', userMessageId: messageId, locale: null, origin: null,
    accessVersion: '0'.repeat(64) }, 604800)
}

/** 升级时为仍可恢复的子运行补齐准入，保持原执行身份。 */
export async function migrateWebSubagentStartups(db: Kysely<Database>, secret: string): Promise<void> {
  let after = ''
  for (;;) {
    const { rows } = await sql<{ owner_id: string; session_id: string; run_id: string }>`
      SELECT d.owner_id,s.id::text AS session_id,e.child_run_id AS run_id
      FROM agent_subagent_deliveries d
      JOIN agent_subagent_executions e USING(child_run_id)
      JOIN agent_subagent_conversations c ON c.owner_id=d.owner_id AND c.parent_session_id=d.parent_session_id
        AND c.child_id=d.child_id AND c.current_run_id=e.child_run_id AND c.child_session_id=e.child_session_id
      JOIN conversation_sessions s ON s.id=e.child_session_id AND s.user_id::text=d.owner_id
      WHERE d.status IN ('queued','running') AND e.payload IS NOT NULL AND s.source='subagent'
        AND e.child_run_id>${after}
        AND NOT EXISTS (SELECT 1 FROM agent_run_dispatch a
          WHERE a.user_id=s.user_id AND a.session_id=s.id AND a.run_id=e.child_run_id)
      ORDER BY e.child_run_id LIMIT 64`.execute(db)
    if (!rows.length) return
    for (const row of rows) await db.transaction().execute(tx => registerWebSubagentStartup(tx, {
      ownerId: row.owner_id, sessionId: row.session_id, runId: row.run_id,
    }, secret))
    after = rows[rows.length - 1]!.run_id
  }
}

/** 依赖 agent_run_startups 的复合主键以及上述共享会话锁约定。 */
export function createPostgresAgentRunStartupStore(pool: Pick<Pool, 'connect' | 'query'>) {
  return {
    async register(identity: RunIdentity): Promise<boolean> {
      return withPostgresTransaction(pool, async client => {
        if (!await lockAgentRunSession(client, identity)) return false
        return registerAgentRunStartupLocked(client, identity)
      })
    },
    async failStart(identity: RunIdentity): Promise<boolean> {
      const args = parameters(identity)
      return withPostgresTransaction(pool, async client => {
        if (!await lockAgentRunSession(client, identity)) return false
        // 持有同一会话锁时，租约取得和首次 checkpoint 创建不能并发穿过此判定。
        const result = await client.query(`UPDATE agent_run_startups AS startup SET status = 'failed', updated_at = clock_timestamp()
          WHERE startup.user_id = $1 AND startup.session_id = $2 AND startup.run_id = $3 AND startup.status = 'pending'
            AND NOT EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id = $1 AND c.session_id = $2 AND c.run_id = $3)
            AND NOT EXISTS (SELECT 1 FROM agent_run_leases l WHERE l.user_id = $1 AND l.session_id = $2 AND l.expires_at > clock_timestamp())
          RETURNING startup.run_id`, args)
        return result.rowCount === 1
      })
    },
    async readFailure(identity: RunIdentity): Promise<boolean> {
      const result = await pool.query(`SELECT 1 FROM agent_run_startups WHERE user_id = $1 AND session_id = $2 AND run_id = $3 AND status = 'failed'`, parameters(identity))
      return result.rowCount === 1
    },
  }
}
