import { createHash } from 'node:crypto'
import type { SqlDataRuntime } from '@gugu/core/data'
import { dataContext } from '@gugu/core/contracts'
import type { UndoLastActionPort, UndoLastActionRequest } from '@gugu/core/tools'
import type { Pool } from 'pg'
import type { AgentDispatchLease } from '../persistence/agent-run-dispatch-postgres.js'
import type { createHostCoreUndoOperations } from '../../undo/persistence/core-operations.js'

type UndoOperations = ReturnType<typeof createHostCoreUndoOperations>
type UndoRequest = UndoLastActionRequest & { signal: AbortSignal }

export interface WebAgentUndoLastActionOptions {
  core: SqlDataRuntime
  pool: Pick<Pool, 'query'>
  lease: AgentDispatchLease
  operations: UndoOperations
}

function uuid(parts: readonly string[], phase: string) {
  const hash = createHash('sha256').update(JSON.stringify([...parts, phase])).digest('hex')
  const raw = `${hash.slice(0, 12)}5${hash.slice(13, 16)}8${hash.slice(17, 32)}`
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
}

/** 将当前 Web lease 绑定到既有 Core/Host Undo 状态机，并固定撤销目标以支持恢复。 */
export function createWebAgentUndoLastActionPort(options: WebAgentUndoLastActionOptions): UndoLastActionPort {
  if (!options.core.receipts) throw new Error('Agent 撤销需要持久操作收据')
  const expected = Object.freeze({ ...options.lease.identity })
  if (options.lease.input.v !== 2 || options.lease.input.source !== 'web') throw new TypeError('Web Agent 撤销来源无法验证')
  const context = dataContext(expected.ownerId)
  const undoContext = `agent:${expected.sessionId}:${expected.runId}`.slice(0, 128)
  const absent = new Error('Agent 撤销收据不存在')

  function coordinates(input: UndoLastActionRequest) {
    if (input.identity.ownerId !== expected.ownerId || input.identity.sessionId !== expected.sessionId
      || input.identity.runId !== expected.runId || !input.roundId.trim() || !input.toolCallId.trim())
      throw new Error('Agent 撤销授权已失效')
    const parts = ['agent.undo.last_action', expected.ownerId, expected.sessionId, expected.runId, input.roundId, input.toolCallId]
    return { reservationId: uuid(parts, 'selection'), resultId: uuid(parts, 'result') }
  }

  async function active(signal: AbortSignal) {
    signal.throwIfAborted()
    const result = await options.pool.query(`SELECT 1 FROM conversation_sessions s
      JOIN agent_run_dispatch d ON d.user_id=s.user_id AND d.session_id=s.id
      WHERE s.user_id=$1 AND s.id=$2 AND s.active_run_id=$3 AND d.run_id=$3 AND d.state='selected'
        AND d.token=$4 AND d.fence=$5 AND d.lease_expires_at>clock_timestamp()`,
    [expected.ownerId, expected.sessionId, expected.runId, options.lease.token, options.lease.fence])
    signal.throwIfAborted()
    return result.rowCount === 1
  }

  async function selection(input: UndoLastActionRequest) {
    const key = coordinates(input)
    const receipt = await options.core.operationWithTransaction(context, key.reservationId,
      'agent.undo.last_action.selection', { undo_context: undoContext }, async (tx, owner) => {
        let query = tx.selectFrom('undo_operations').select(['id', 'resource']).where('user_id', '=', owner)
          .where('undo_context_id', '=', undoContext).where('actor_type', '=', 'web').where('status', '=', 'active')
          .orderBy('created_at', 'desc').orderBy('id', 'desc')
        if (options.core.backend === 'postgres') query = query.forUpdate()
        const row = await query.executeTakeFirst()
        return { operation_id: row?.id ?? null, resource: row?.resource ?? null }
      })
    const saved = receipt.result as { operation_id: string | null; resource: string | null }
    return { ...key, operationId: saved.operation_id, resource: saved.resource }
  }

  async function recordedSelection(input: UndoLastActionRequest) {
    try {
      const key = coordinates(input)
      const receipt = await options.core.operationWithTransaction(context, key.reservationId,
        'agent.undo.last_action.selection', { undo_context: undoContext }, async () => { throw absent })
      const saved = receipt.result as { operation_id: string | null; resource: string | null }
      return { ...key, operationId: saved.operation_id, resource: saved.resource }
    } catch { return null }
  }

  async function readResult(input: UndoLastActionRequest): Promise<import('@gugu/core/agent').ToolResult> {
    try {
      const selected = await recordedSelection(input)
      if (!selected) return { kind: 'unknown' }
      const receipt = await options.core.operationWithTransaction(context, selected.resultId,
        'agent.undo.last_action.result', { operation_id: selected.operationId }, async () => { throw absent })
      const result = receipt.result as Record<string, unknown>
      return { kind: 'completed', successful: result.success === true, mutated: false, value: result }
    } catch { return { kind: 'unknown' } }
  }

  async function persistResult(input: UndoRequest, operationId: string | null, value: Record<string, unknown>) {
    const key = coordinates(input)
    try {
      const receipt = await options.core.operationWithTransaction(context, key.resultId,
        'agent.undo.last_action.result', { operation_id: operationId }, async () => value)
      const result = receipt.result as Record<string, unknown>
      return { kind: 'completed' as const, successful: result.success === true,
        mutated: result.success === true && !receipt.replayed && result.idempotent !== true, value: result }
    } catch { return readResult(input) }
  }

  return {
    async reconcile(input) { return readResult(input) },
    async apply(input) {
      input.signal.throwIfAborted()
      if (input.identity.ownerId !== expected.ownerId || input.identity.sessionId !== expected.sessionId
        || input.identity.runId !== expected.runId || !await active(input.signal))
        return { kind: 'completed', successful: false, mutated: false, value: { error: 'Agent 撤销授权已失效' } }
      let selected
      try { selected = await selection(input) }
      catch { return { kind: 'unknown' } }
      const known = await readResult(input)
      if (known.kind === 'completed') return known
      if (selected.operationId === null) return persistResult(input, null, { success: false, error: '当前运行没有可撤销的操作' })
      if (!['mind', 'calendar', 'scheduled_tasks', 'files', 'projects'].includes(selected.resource ?? ''))
        return persistResult(input, selected.operationId, { success: false, error: '最近操作类型尚无 Node 撤销处理器' })
      if (!await active(input.signal)) return { kind: 'unknown' }
      input.signal.throwIfAborted()
      let value: Record<string, unknown>
      try {
        const outcome = await options.operations.apply(expected.ownerId, undoContext, selected.operationId, 'undo')
        value = { success: true, operation: outcome.operation, idempotent: outcome.idempotent }
      } catch (error) {
        const code = error !== null && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 0
        if (code === 404) value = { success: false, error: '没有可撤销的操作' }
        else if (code === 409) value = { success: false, error: '最近的操作已变化，无法撤销' }
        else return { kind: 'unknown' }
      }
      return persistResult(input, selected.operationId, value)
    },
  }
}
