import type { RunIdentity, ToolResult } from '../../models.js'
import type { ToolDefinition } from '../contracts.js'

export interface UndoLastActionRequest {
  identity: RunIdentity
  roundId: string
  toolCallId: string
}

export interface UndoLastActionPort {
  apply(input: UndoLastActionRequest & { signal: AbortSignal }): Promise<ToolResult>
  reconcile(input: UndoLastActionRequest): Promise<ToolResult>
}

/** 只撤销当前 Agent Run 产生的最近一项可撤销操作；目标由 Host 从可信上下文选择。 */
export function createUndoLastActionTool(port: UndoLastActionPort): ToolDefinition {
  const parse = (input: unknown) => input !== null && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).length === 0 ? { success: true as const, data: input } : { success: false as const }
  return {
    definition: { name: 'undo_last_action', schema: { type: 'function', function: {
      name: 'undo_last_action',
      description: '撤销当前 Agent Run 中最近一项仍可撤销的操作；只处理本会话、本轮运行产生的操作，不接受目标 ID。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    } } },
    effect: 'write',
    validate: parse,
    execute(input, scope, call) {
      if (!parse(input).success) return Promise.resolve({ kind: 'completed', successful: false, mutated: false, value: { error: '参数无效' } })
      return port.apply({ identity: scope.identity, roundId: scope.roundId, toolCallId: call.id, signal: scope.signal })
    },
    reconcile(input, identity, call) {
      if (!parse(input).success) return Promise.resolve({ kind: 'unknown' })
      return port.reconcile({ identity, roundId: identity.roundId, toolCallId: call.id })
    },
  }
}
