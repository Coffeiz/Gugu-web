import { createHash } from 'node:crypto'
import { dataContext } from '../../contracts/index.js'
import type { SqlDataRuntime } from '../../data/runtime.js'
import type { RunIdentity, ToolResult } from '../models.js'
import type { UndoLastActionPort, UndoLastActionRequest } from './undo.js'

const missing = new Error('Agent 撤销收据不存在')

function operationId(parts: readonly string[], phase: string) {
  const hash = createHash('sha256').update(JSON.stringify([...parts, phase])).digest('hex')
  const raw = `${hash.slice(0, 12)}5${hash.slice(13, 16)}8${hash.slice(17, 32)}`
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
}

export interface AgentUndoLastActionOptions {
  core: SqlDataRuntime
  identity: RunIdentity
  undoContextId: string
  active(input: UndoLastActionRequest, signal: AbortSignal): Promise<boolean>
  apply(ownerId: string, undoContextId: string, operationId: string, resource: string, signal: AbortSignal): Promise<Record<string, unknown>>
}

/** Run 绑定、撤销目标冻结与结果收据由 Web/Desktop 共用；Host 只负责活动 Run 校验和平台撤销适配。 */
export function createAgentUndoLastActionPort(options: AgentUndoLastActionOptions): UndoLastActionPort {
  if (!options.core.receipts) throw new Error('Agent 撤销需要持久操作收据')
  const expected = Object.freeze({ ...options.identity })
  const context = dataContext(expected.ownerId)
  const undoContextId = options.undoContextId.trim().slice(0, 128)

  function coordinates(input: UndoLastActionRequest) {
    if (input.identity.ownerId !== expected.ownerId || input.identity.sessionId !== expected.sessionId
      || input.identity.runId !== expected.runId || !input.roundId.trim() || !input.toolCallId.trim())
      throw new Error('Agent 撤销授权已失效')
    const parts = ['agent.undo.last_action', expected.ownerId, expected.sessionId, expected.runId, input.roundId, input.toolCallId]
    return { reservationId: operationId(parts, 'selection'), resultId: operationId(parts, 'result') }
  }

  async function selection(input: UndoLastActionRequest) {
    const key = coordinates(input)
    const receipt = await options.core.operationWithTransaction(context, key.reservationId,
      'agent.undo.last_action.selection', { undo_context: undoContextId }, async (tx, owner) => {
        let query = tx.selectFrom('undo_operations').select(['id', 'resource'])
          .where('user_id', '=', owner).where('undo_context_id', '=', undoContextId)
          .where('actor_type', '=', 'web').where('status', '=', 'active')
          .orderBy('created_at', 'desc').orderBy('id', 'desc')
        if (options.core.backend === 'postgres') query = query.forUpdate()
        const row = await query.executeTakeFirst()
        return { operation_id: row?.id ?? null, resource: row?.resource ?? null }
      })
    return { ...key, ...(receipt.result as { operation_id: string | null; resource: string | null }) }
  }

  async function recordedSelection(input: UndoLastActionRequest) {
    try {
      const key = coordinates(input)
      const receipt = await options.core.operationWithTransaction(context, key.reservationId,
        'agent.undo.last_action.selection', { undo_context: undoContextId }, async () => { throw missing })
      return { ...key, ...(receipt.result as { operation_id: string | null; resource: string | null }) }
    } catch { return null }
  }

  async function readResult(input: UndoLastActionRequest): Promise<ToolResult> {
    try {
      const selected = await recordedSelection(input)
      if (!selected) return { kind: 'unknown' }
      const receipt = await options.core.operationWithTransaction(context, selected.resultId,
        'agent.undo.last_action.result', { operation_id: selected.operation_id }, async () => { throw missing })
      const value = receipt.result as Record<string, unknown>
      return { kind: 'completed', successful: value.success === true, mutated: false, value }
    } catch { return { kind: 'unknown' } }
  }

  async function persistResult(input: UndoLastActionRequest, operation: string | null, value: Record<string, unknown>) {
    const key = coordinates(input)
    try {
      const receipt = await options.core.operationWithTransaction(context, key.resultId,
        'agent.undo.last_action.result', { operation_id: operation }, async () => value)
      const saved = receipt.result as Record<string, unknown>
      return { kind: 'completed' as const, successful: saved.success === true,
        mutated: saved.success === true && !receipt.replayed && saved.idempotent !== true, value: saved }
    } catch { return readResult(input) }
  }

  return {
    reconcile: readResult,
    async apply(input) {
      input.signal.throwIfAborted()
      if (input.identity.ownerId !== expected.ownerId || input.identity.sessionId !== expected.sessionId
        || input.identity.runId !== expected.runId || !await options.active(input, input.signal))
        return { kind: 'completed', successful: false, mutated: false, value: { error: 'Agent 撤销授权已失效' } }
      let selected: Awaited<ReturnType<typeof selection>>
      try { selected = await selection(input) } catch { return { kind: 'unknown' } }
      const known = await readResult(input)
      if (known.kind === 'completed') return known
      if (selected.operation_id === null)
        return persistResult(input, null, { success: false, error: '当前运行没有可撤销的操作' })
      if (!await options.active(input, input.signal)) return { kind: 'unknown' }
      input.signal.throwIfAborted()
      let value: Record<string, unknown>
      try {
        value = await options.apply(expected.ownerId, undoContextId, selected.operation_id, selected.resource ?? '', input.signal)
      } catch { return { kind: 'unknown' } }
      return persistResult(input, selected.operation_id, value)
    },
  }
}
