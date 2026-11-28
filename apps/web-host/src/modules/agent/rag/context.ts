import { createAgentRagContextBuilder } from '@gugu/core/agent/rag'
import type { ContextSourceSelection, HistoryIdentity, RagContext, RunIdentity } from '@gugu/core/agent'
import type { RagSearchScope } from '@gugu/core/agent/rag'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { ProviderTransport } from '@gugu/core/providers'
import type { Pool } from 'pg'
import type { AgentDispatchLease } from '../run/dispatch.js'
import { createOwnerAgentRagVectorResolver } from './vectors.js'

/**
 * Web keeps its lease and policy checks at the Host boundary; the common Core
 * builder owns the ranking and replayable context projection used by Desktop too.
 */
export function createWebAgentRagContextBuilder(options: {
  core: Pick<SqlDataRuntime, 'db' | 'backend'>
  pool: Pick<Pool, 'query'>
  storageRoot: string
  lease: AgentDispatchLease
  selection: Pick<ContextSourceSelection, 'contextPolicy' | 'contextScopeKey' | 'modelIdentity'>
  enabled(lease: AgentDispatchLease): boolean | Promise<boolean>
  embedding?: {
    resolve(ownerId: string, signal?: AbortSignal): Promise<import('@gugu/core/agent/rag').RagQueryEmbeddingSettings | null>
    createTransport(settings: import('@gugu/core/agent/rag').RagQueryEmbeddingSettings): ProviderTransport
  }
  conversationMessageTime?(identity: HistoryIdentity, timestamp: string, signal?: AbortSignal): Promise<string>
}) {
  const { pool, selection, enabled: hostEnabled, embedding, ...contextOptions } = options
  const lease = contextOptions.lease
  if (lease.input.v !== 2 || lease.input.source !== 'web') throw new TypeError('Web Agent RAG 运行来源无法验证')
  if (!selection.modelIdentity || !selection.contextScopeKey || selection.contextScopeKey !== lease.input.accessVersion)
    throw new TypeError('Web Agent RAG 配置版本与调度授权不匹配')
  const bound = Object.freeze({ ...lease.identity })
  const policy = Object.freeze({ ...selection.contextPolicy })
  const enabled = async (candidate: AgentDispatchLease) => {
    if (!policy.loadOwnerContext || candidate.identity.ownerId !== bound.ownerId
      || candidate.identity.sessionId !== bound.sessionId || candidate.identity.runId !== bound.runId
      || candidate.token !== lease.token || candidate.fence !== lease.fence) return false
    return hostEnabled(candidate)
  }
  const authorize = async (candidate: AgentDispatchLease, scope: RagSearchScope, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    if (!policy.loadOwnerContext || candidate.identity.ownerId !== bound.ownerId
      || candidate.identity.sessionId !== bound.sessionId || candidate.identity.runId !== bound.runId
      || candidate.token !== lease.token || candidate.fence !== lease.fence
      || scope.scope_type !== 'owner' || (scope.scope_id ?? '') !== '') return false
    const active = await pool.query(`SELECT 1 FROM conversation_sessions s
      JOIN agent_run_dispatch d ON d.user_id=s.user_id AND d.session_id=s.id
      WHERE s.user_id=$1 AND s.id=$2 AND s.active_run_id=$3
        AND d.run_id=$3 AND d.state='selected' AND d.token=$4 AND d.fence=$5 AND d.lease_expires_at>clock_timestamp()`,
    [bound.ownerId, bound.sessionId, bound.runId, lease.token, lease.fence])
    signal?.throwIfAborted()
    return active.rowCount === 1
  }
  const vectors = embedding ? createOwnerAgentRagVectorResolver({
    root: contextOptions.storageRoot,
    resolveEmbedding: embedding.resolve,
    createTransport: embedding.createTransport,
  }) : undefined

  const build = createAgentRagContextBuilder({
    core: contextOptions.core,
    identity: bound,
    enabled: () => enabled(lease),
    authorize: (_identity: RunIdentity, scope, signal) => authorize(lease, scope, signal),
    ...(vectors ? { vectors } : {}),
    ...(options.conversationMessageTime ? { conversationMessageTime: options.conversationMessageTime } : {}),
  })
  return (input: HistoryIdentity & {
    query: string
    history: readonly import('@gugu/core/agent').PersistedHistoryRow[]
    beforeMessageId: string | null
    snapshotText: string
  }, signal?: AbortSignal): Promise<RagContext> => build(input, signal)
}
