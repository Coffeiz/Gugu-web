import type { CanonicalRunPreparationPorts, RunIdentity } from '@gugu/core/agent'
import type { Pool } from 'pg'
import type { AgentDispatchLease } from '../persistence/agent-run-dispatch-postgres.js'

const RAG_TOOLS = new Set(['search_conversations', 'search_memory'])

/**
 * Web RAG 的最小可信配置与执行授权：工具集合固定为已实现的只读 RAG 工具，
 * 每次配置发现和实际执行都重新验证同一 PostgreSQL dispatch lease。
 */
export function createWebAgentRagRunAuthorization(
  pool: Pick<Pool, 'query'>,
  lease: AgentDispatchLease,
): {
  configuration: CanonicalRunPreparationPorts['configuration']
  authorize(identity: RunIdentity, name: string, signal?: AbortSignal): Promise<boolean>
} {
  if (lease.input.v !== 2 || lease.input.source !== 'web') throw new TypeError('Web Agent RAG 运行来源无法验证')
  const expected = Object.freeze({ ...lease.identity })
  const names = Object.freeze(['search_conversations', 'search_memory'])
  const same = (identity: RunIdentity) => identity.ownerId === expected.ownerId
    && identity.sessionId === expected.sessionId && identity.runId === expected.runId
  const active = async (identity: RunIdentity, signal: AbortSignal): Promise<boolean> => {
    signal.throwIfAborted()
    if (!same(identity)) return false
    const result = await pool.query(`SELECT 1 FROM conversation_sessions s
      JOIN agent_run_dispatch d ON d.user_id=s.user_id AND d.session_id=s.id
      WHERE s.user_id=$1 AND s.id=$2 AND s.active_run_id=$3
        AND d.run_id=$3 AND d.state='selected' AND d.token=$4 AND d.fence=$5
        AND d.lease_expires_at>clock_timestamp()`,
    [expected.ownerId, expected.sessionId, expected.runId, lease.token, lease.fence])
    signal.throwIfAborted()
    return result.rowCount === 1
  }
  return {
    async configuration(identity, signal) {
      if (!await active(identity, signal)) throw new Error('Web Agent RAG 运行授权不可用')
      return {
        identity: { ownerId: expected.ownerId, workspaceId: null, subject: { kind: 'session', id: expected.sessionId } },
        source: 'web',
        toolNames: names,
      }
    },
    async authorize(identity, name, signal = new AbortController().signal) {
      return RAG_TOOLS.has(name) && await active(identity, signal)
    },
  }
}
