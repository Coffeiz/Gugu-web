import type { Pool } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import type { AgentDispatchLease } from '../persistence/agent-run-dispatch-postgres.js'

/** MCP 是 Web Run 的副作用边界；每次外呼前确认同一 owner/run 的 fencing lease 仍有效。 */
export function createWebAgentMcpRunAuthorization(pool: Pick<Pool, 'query'>, lease: AgentDispatchLease) {
  if (lease.input.v !== 2 || lease.input.source !== 'web') throw new TypeError('Web Agent MCP 运行来源无法验证')
  const expected = Object.freeze({ ...lease.identity })

  return {
    async authorize(identity: RunIdentity, name: string, signal?: AbortSignal): Promise<boolean> {
      signal?.throwIfAborted()
      if (!name.startsWith('mcp_') || name.length > 256
        || identity.ownerId !== expected.ownerId || identity.sessionId !== expected.sessionId
        || identity.runId !== expected.runId) return false

      const active = await pool.query(`SELECT 1 FROM conversation_sessions s
        JOIN agent_run_dispatch d ON d.user_id=s.user_id AND d.session_id=s.id
        WHERE s.user_id=$1 AND s.id=$2 AND s.active_run_id=$3
          AND d.run_id=$3 AND d.state='selected' AND d.token=$4 AND d.fence=$5
          AND d.lease_expires_at>clock_timestamp()`,
      [expected.ownerId, expected.sessionId, expected.runId, lease.token, lease.fence])
      signal?.throwIfAborted()
      return active.rowCount === 1
    },
  }
}
