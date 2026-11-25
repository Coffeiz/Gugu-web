import type { ExecutionResult } from '../executor/contracts.js'
import { AgentRunError, type InteractionResolution, type RunCheckpoint, type RunIdentity, type ToolCall, type ToolResult } from '../models.js'
import type { AgentRunnerPorts } from '../ports.js'
import { recordAgentObservation } from '../observation.js'
import { cancellable } from '../run/cancellation.js'
import type { createRunnerObservation } from './observation.js'

export function bindToolExecution<C>(ports: AgentRunnerPorts<C>, identity: RunIdentity, runSignal: AbortSignal, options: {
  readState: () => RunCheckpoint<C>
  dispatchKey: (call: ToolCall) => string
  dispatchedCalls: Set<string>
  uncertainExecutions: Set<string>
  observation: ReturnType<typeof createRunnerObservation<C>>
}) {
  const { readState, dispatchKey, dispatchedCalls, uncertainExecutions, observation } = options
  const { observedAt, logRun, recordToolInvocation, recordToolSchemaFailure } = observation
  return async function executeTool(call: ToolCall, resolving: InteractionResolution | null, signal = runSignal, waitForCleanup = false): Promise<ToolResult> {
    if (signal.aborted)
      throw new AgentRunError('cancelled', '当前任务已取消')
    const startedAt = observedAt()
    const round = readState().round
    if (call.parseError) {
      logRun(identity, 'warn', 'agent.tools.dispatch_failed', readState().round, { errorCode: 'invalid_arguments' })
      recordToolInvocation(identity, call, round, 'invalid', startedAt, { executed: false, errorCode: 'invalid_arguments' })
      if (readState().context !== null)
        recordToolSchemaFailure(identity, readState().context, call, readState().round, 'parse_error',
          { parse_error: true, code: call.parseError }, `${identity.runId}:round:${readState().round}:tool:${call.id}`)
      recordAgentObservation(ports.observation, {
        identity, kind: 'tool', name: call.name, at: observedAt(), round: readState().round,
        spanId: `${identity.runId}:round:${readState().round}:tool:${call.id}`,
        parentSpanId: `${identity.runId}:round:${readState().round}`, status: 'invalid',
        attributes: { toolCallId: call.id, parseError: call.parseError },
      })
      return { kind: 'completed', value: { error: '工具参数不是合法的 JSON 对象，请修正参数后重试', code: call.parseError }, executed: false, successful: false, mutated: false }
    }
    dispatchedCalls.add(dispatchKey(call))
    const toolSpanId = `${identity.runId}:round:${round}:tool:${call.id}`
    recordAgentObservation(ports.observation, {
      identity, kind: 'tool', name: call.name, at: observedAt(), round, spanId: toolSpanId,
      parentSpanId: `${identity.runId}:round:${round}`, status: 'running', input: call.input,
      attributes: { toolCallId: call.id },
    })
    let closed = false
    let uncertain = false
    let observed: { readonly result: ToolResult } | { readonly error: unknown } | null = null
    const executions = new Set<Promise<ExecutionResult>>()
    let dispatched
    try {
      const context = readState().context
      dispatched = ports.tools.dispatch(call, {
        identity,
        loadedSkills: call.name !== 'use_skill' || context === null ? undefined : await ports.context.loadedSkills?.(context),
        roundId: `${identity.runId}:${round}`,
        signal,
        resolution: resolving,
        execute: (request) => {
          if (closed)
            return Promise.reject(new AgentRunError('invalid_state', '工具派发生命周期已结束'))
          const executing = Promise.resolve().then(() => ports.execution.execute({ ...identity, roundId: `${identity.runId}:${round}`, toolCallId: call.id }, request, signal)).catch((error) => {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'native_failure') {
              uncertain = true
              uncertainExecutions.add(`${round}:${call.id}`)
            }
            throw error
          })
          executions.add(executing)
          void executing.catch(() => undefined)
          return executing
        },
      })
    }
    catch (error) {
      dispatched = Promise.reject(error)
    }
    const operation = dispatched.then(async (result) => {
      observed = { result }
      let count = -1
      while (count !== executions.size) {
        count = executions.size
        await Promise.allSettled([...executions])
      }
      return uncertain ? { kind: 'unknown' as const } : result
    }, async (error) => {
      observed = { error }
      await Promise.allSettled([...executions])
      if (uncertain)
        return { kind: 'unknown' as const }
      throw error
    }).finally(() => { closed = true })
    try {
      const result = waitForCleanup ? await operation : await cancellable(operation, signal).catch(async (error) => {
        if (error instanceof AgentRunError && error.code === 'cancelled') {
          // ToolPort的确定回执先到时优先保留，资源清理所需额外await不能反转完成/取消顺序。
          const completed = observed
          const settled = await operation.then((value) => ({ result: value }), () => null)
          if (completed && 'result' in completed && settled)
            return settled.result
        }
        throw error
      })
      if (result.kind === 'waiting')
        recordToolInvocation(identity, call, round, 'waiting', startedAt, { executed: true, interaction: result.interaction.kind })
      else if (result.kind === 'unknown')
        recordToolInvocation(identity, call, round, 'unknown', startedAt, { executed: true, errorCode: 'result_unknown' })
      else {
        const outcome = result.value && typeof result.value === 'object' && 'status' in result.value
          && ['cancelled', 'deferred'].includes(String(result.value.status))
          ? result.value.status as 'cancelled' | 'deferred' : result.successful ? 'success' : 'error'
        const code = result.value && typeof result.value === 'object' && 'code' in result.value
          && typeof result.value.code === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/i.test(result.value.code)
          ? result.value.code : null
        recordToolInvocation(identity, call, round, outcome, startedAt, {
          executed: result.executed !== false, mutated: result.mutated,
          ...(code ? { errorCode: code } : {}),
        })
      }
      return result
    }
    catch (error) {
      const cancelled = error instanceof AgentRunError && error.code === 'cancelled'
      recordToolInvocation(identity, call, round, cancelled ? 'cancelled' : 'error', startedAt,
        { executed: dispatchedCalls.has(dispatchKey(call)), errorCode: cancelled ? 'cancelled' : 'tool_failed' })
      throw error
    }
  }
}
