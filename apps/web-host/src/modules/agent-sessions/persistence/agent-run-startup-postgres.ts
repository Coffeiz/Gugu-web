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

/** 调用方必须已持有同一会话行锁；登记与用户消息事务一同提交。 */
export async function registerAgentRunStartupLocked(client: PoolClient, identity: RunIdentity): Promise<boolean> {
  const result = await client.query(`INSERT INTO agent_run_startups (user_id, session_id, run_id, status, created_at, updated_at)
    VALUES ($1, $2, $3, 'pending', clock_timestamp(), clock_timestamp()) ON CONFLICT DO NOTHING`, parameters(identity))
  return result.rowCount === 1
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
