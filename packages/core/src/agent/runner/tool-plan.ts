import { AgentRunError } from '../models.js'
import type { ToolCall, ToolPlan } from '../models.js'
import { snapshotToolResult } from '../context/history/canonical-history.js'

export function partitionToolPlan(calls: readonly ToolCall[], plan: ToolPlan) {
  const known = new Map(calls.map((call) => [call.id, call]))
  const isolated = (plan.isolatedResults ?? []).map((item) => {
    const call = known.get(item.callId)
    if (!call)
      throw new AgentRunError('invalid_state', '工具执行计划包含未知调用')
    return { callId: item.callId, result: snapshotToolResult(item.result, call) }
  })
  if (new Set(isolated.map((item) => item.callId)).size !== isolated.length)
    throw new AgentRunError('invalid_state', '工具执行计划包含重复调用')
  const isolatedIds = new Set(isolated.map((item) => item.callId))
  const requestedSerial = plan.mode === 'parallel' ? [...(plan.serialCallIds ?? [])] : calls.map((call) => call.id).filter((id) => !isolatedIds.has(id))
  if (new Set(requestedSerial).size !== requestedSerial.length || requestedSerial.some((id) => !known.has(id) || isolatedIds.has(id)))
    throw new AgentRunError('invalid_state', '工具串行计划无效')
  const serial = calls.filter((call) => requestedSerial.includes(call.id)).map((call) => call.id)
  if (plan.mode === 'parallel' && (!Number.isSafeInteger(plan.maxConcurrency) || plan.maxConcurrency < 1 || plan.maxConcurrency > 128))
    throw new AgentRunError('invalid_state', '工具并发上限无效')
  return {
    parallelCallIds: plan.mode === 'parallel' ? calls.filter((call) => !serial.includes(call.id) && !isolatedIds.has(call.id)).map((call) => call.id) : [],
    serialCallIds: serial,
    isolatedCallIds: isolated.map((item) => item.callId),
    parallelLimit: plan.mode === 'parallel' ? plan.maxConcurrency : null,
    toolResults: isolated,
  }
}
