import type { AuthorizedMemoryScope, MemorySearchSnapshot } from '@gugu/core/agent/rag'
import type { RunIdentity } from '@gugu/core/agent'
import type { Pool } from 'pg'
import type { AgentDispatchLease } from '../persistence/agent-run-dispatch-postgres.js'
import type { createAgentToolRegistry } from './agent-tool-registry.js'
import type { CanonicalRunPreparationPorts } from '@gugu/core/agent'

type Registry = Pick<ReturnType<typeof createAgentToolRegistry>, 'capabilities'>
type Preparation = Pick<CanonicalRunPreparationPorts, 'configuration'>

function sameRun(identity: RunIdentity, expected: RunIdentity): boolean {
  return identity.ownerId === expected.ownerId
    && identity.sessionId === expected.sessionId
    && identity.runId === expected.runId
}

function asContext(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch { /* 数据损坏必须在调用处明确失败。 */ }
  }
  throw new Error('Agent RAG 会话快照无效')
}

/**
 * 给 Web memory 查询绑定当前持久 Run 的授权与配置。
 * 每次查询都重新读工具配置和授权能力；lease 本身不包含模型可控的 scope。
 */
export function createWebAgentMemoryAuthorizer(
  pool: Pick<Pool, 'query'>,
  lease: AgentDispatchLease,
  registry: Registry,
  preparation: Preparation,
) {
  if (lease.input.v !== 2 || lease.input.source !== 'web') throw new TypeError('Web Agent RAG 运行来源无法验证')
  const bound = Object.freeze({ ...lease.identity })
  return async (identity: RunIdentity, signal: AbortSignal, scopes?: readonly AuthorizedMemoryScope[]): Promise<boolean> => {
    signal.throwIfAborted()
    if (!sameRun(identity, bound) || (scopes && (!scopes.length || scopes.some(scope =>
      scope.type !== 'owner' || scope.ownerId.toLowerCase() !== bound.ownerId.toLowerCase()
      || (scope.id && scope.id.toLowerCase() !== bound.ownerId.toLowerCase()))))) return false

    const active = await pool.query<{ active_run_id: string }>(
      `SELECT active_run_id FROM conversation_sessions WHERE user_id=$1 AND id=$2 AND active_run_id=$3`,
      [bound.ownerId, bound.sessionId, bound.runId],
    )
    signal.throwIfAborted()
    if (active.rows.length !== 1 || active.rows[0]?.active_run_id !== bound.runId) return false

    const configured = await preparation.configuration(bound, signal)
    signal.throwIfAborted()
    if (configured.source !== 'web' || configured.identity.ownerId !== bound.ownerId || configured.identity.subject.kind !== 'session'
      || configured.identity.subject.id !== bound.sessionId || !configured.toolNames.includes('search_memory')) return false

    const capabilities = await registry.capabilities(bound)
    signal.throwIfAborted()
    return sameRun(identity, bound) && capabilities.some(definition => definition.name === 'search_memory')
  }
}

/**
 * 从 owner/session/run 三重限定的 PostgreSQL 会话快照读取本轮 RAG 去重上下文。
 * 不存在当前 Run、快照损坏或缺少版本时拒绝检索，不能退回空快照。
 */
export function createPostgresWebAgentMemorySnapshotReader(pool: Pick<Pool, 'query'>, lease: AgentDispatchLease) {
  if (lease.input.v !== 2 || lease.input.source !== 'web') throw new TypeError('Web Agent RAG 运行来源无法验证')
  return createPostgresAgentMemorySnapshotReader(pool, lease.identity)
}

/** 来源适配器先验证各自dispatch版本；共享读取只接受精确绑定的Run身份。 */
export function createPostgresAgentMemorySnapshotReader(pool: Pick<Pool, 'query'>, expected: RunIdentity) {
  const bound = Object.freeze({ ...expected })
  if (!bound.ownerId || !bound.runId || !/^[1-9]\d*$/u.test(bound.sessionId)) throw new TypeError('Agent RAG 运行身份无效')
  return async (identity: RunIdentity, signal: AbortSignal): Promise<MemorySearchSnapshot> => {
    signal.throwIfAborted()
    if (!sameRun(identity, bound)) throw new Error('Agent RAG 运行身份不匹配')

    const result = await pool.query<{ active_run_id: string | null; context_epoch: number; session_context: unknown }>(
      `SELECT active_run_id,context_epoch,session_context FROM conversation_sessions
       WHERE user_id=$1 AND id=$2 AND active_run_id=$3`,
      [bound.ownerId, bound.sessionId, bound.runId],
    )
    signal.throwIfAborted()
    const row = result.rows[0]
    if (!row || row.active_run_id !== bound.runId || !Number.isSafeInteger(row.context_epoch) || row.context_epoch < 0)
      throw new Error('Agent RAG 当前会话不可用')

    const context = asContext(row.session_context)
    const revision = context.rag_revision ?? context.context_revision
    if (!(typeof revision === 'string' && revision.length > 0)
      && !(typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0))
      throw new Error('Agent RAG 会话版本无效')
    const text = context.snapshot_context
    if (typeof text !== 'string') throw new Error('Agent RAG 会话内容无效')
    return { revision: `${row.context_epoch}:${revision}`, text }
  }
}
