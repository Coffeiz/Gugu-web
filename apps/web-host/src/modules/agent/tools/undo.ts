import { createAgentUndoLastActionPort, type UndoLastActionRequest } from '@gugu/core/tools'
import type { Pool } from 'pg'
import type { AgentDispatchLease } from '../run/dispatch.js'
import type { createHostCoreUndoOperations } from '../../undo/service.js'

type UndoOperations = ReturnType<typeof createHostCoreUndoOperations>
export interface WebAgentUndoLastActionOptions {
  core: import('@gugu/core/data').SqlDataRuntime
  pool: Pick<Pool, 'query'>
  lease: AgentDispatchLease
  operations: UndoOperations
}

/** 将当前 Web lease 绑定到既有 Core/Host Undo 状态机，并固定撤销目标以支持恢复。 */
export function createWebAgentUndoLastActionPort(options: WebAgentUndoLastActionOptions) {
  const expected = Object.freeze({ ...options.lease.identity })
  if (options.lease.input.v !== 2 || options.lease.input.source !== 'web') throw new TypeError('Web Agent 撤销来源无法验证')
  const undoContext = `agent:${expected.sessionId}:${expected.runId}`.slice(0, 128)
  return createAgentUndoLastActionPort({
    core: options.core, identity: expected, undoContextId: undoContext,
    async active(_input, signal) {
      signal.throwIfAborted()
      const result = await options.pool.query(`SELECT 1 FROM conversation_sessions s
        JOIN agent_run_dispatch d ON d.user_id=s.user_id AND d.session_id=s.id
        WHERE s.user_id=$1 AND s.id=$2 AND s.active_run_id=$3 AND d.run_id=$3 AND d.state='selected'
          AND d.token=$4 AND d.fence=$5 AND d.lease_expires_at>clock_timestamp()`,
      [expected.ownerId, expected.sessionId, expected.runId, options.lease.token, options.lease.fence])
      signal.throwIfAborted()
      return result.rowCount === 1
    },
    async apply(ownerId, contextId, operationId, resource) {
      if (!['mind', 'calendar', 'scheduled_tasks', 'files', 'projects', 'skills'].includes(resource))
        return { success: false, error: '最近操作类型尚无 Node 撤销处理器' }
      try {
        const outcome = await options.operations.apply(ownerId, contextId, operationId, 'undo')
        return { success: true, operation: outcome.operation, idempotent: outcome.idempotent }
      } catch (error) {
        const code = error !== null && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 0
        if (code === 404) return { success: false, error: '没有可撤销的操作' }
        if (code === 409) return { success: false, error: '最近的操作已变化，无法撤销' }
        throw error
      }
    },
  })
}
