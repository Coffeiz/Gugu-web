import { ProviderError, providerFailureFields } from './providers/errors.js'
import type { ExecutionResult } from './executor/contracts.js'
import { mergeUsage } from './context/budget.js'
import type { DisplayItem,DispatchOutcome,InteractionResolution,Json,Lease,PortableValue,ProviderCursor,ProviderRecoveryBoundary,ReplyChoice,ReplyGateCall,RunCheckpoint,RunEvent,AgentRunner,RunIdentity,SanitizerCheckpoint,ToolCall,ToolPlan,ToolResult } from './models.js'
import { AgentRunError,isEarlyExit,RunStoreRejected,ToolResultCheckpointUnavailable } from './models.js'
import { cacheResultForRun,encodeResultForRun,hydrateResultForRun,normalizePersistentArtifact } from './context/history/attachment-refs.js'
import { portableSnapshot,redactToolRequestHeaders,snapshotInteraction,snapshotToolCall,snapshotToolResult } from './context/history/canonical-history.js'
import { stripHistoryMedia } from './context/history/ordering.js'
import { activateNextInteractionForRun,closeInteractionsForRun,completeResolutionClosureForRun,resumeWaitingRun } from './interactions/coordinator.js'
import type { AgentRunnerPorts,RunCoordination,StreamSanitizer } from './ports.js'
import { describeShellActivity } from './shell-activity.js'
import { recordAgentObservation } from './observation.js'
import { recordAgentRunLog } from './logging.js'
import { cancellable,checkCancellationForRun,requestRunCancellation,stoppedResultForRun } from './run/cancellation.js'
import { closeToolsForRun,finishForRun } from './run/finalization.js'
import { assertRunCheckpoint,assertRunIdentity,assertRunTransition,decideReply,decideReplyGate,emptyRunUsage,goalCompleted,initialReplyState,readRunCheckpoint,runIdentityKey,stripGoalMarker,terminalRunStates,toolReplyProgress } from './run/lifecycle.js'
import { parallelBatchForRun,providerStreamLifetime,publishRunEvent,replayRunEvents } from './run/streaming.js'
import { rejectAdapterCall } from './tools/call-adapter.js'



function contextSummaryMetrics(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return {}
  const entries = (snapshot as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return {}
  const summaries: string[] = []
  const textOf = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(textOf).join('\n')
    if (!value || typeof value !== 'object') return ''
    const row = value as Record<string, unknown>
    return typeof row.text === 'string' ? row.text : textOf(row.content)
  }
  for (const value of entries) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const message = (value as { message?: unknown }).message
    const content = message && typeof message === 'object' && !Array.isArray(message)
      ? textOf((message as Record<string, unknown>).content) : ''
    if (content.includes('<compacted-summary>')) summaries.push(content)
  }
  return {
    message_count: entries.length,
    summary_count: summaries.length,
    summary_chars: summaries.reduce((total, value) => total + value.length, 0),
  }
}

function skillInjectionMetadata(value: unknown): Record<string, string | number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = value as Record<string, unknown>
  const marker = result._capability_usage
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null
  const usage = marker as Record<string, unknown>
  if (usage.kind !== 'skill' || usage.loaded !== true || typeof usage.id !== 'string'
    || !/^[SU][1-9][0-9]*$/.test(usage.id) || typeof usage.content_digest !== 'string'
    || !/^[a-f0-9]{16,64}$/i.test(usage.content_digest) || typeof result.content !== 'string') return null
  if (usage.id.startsWith('U') && (usage.source !== 'user' || typeof usage.owner_fingerprint !== 'string')) return null
  if (usage.id.startsWith('S') && usage.source !== undefined && usage.source !== 'builtin') return null
  return {
    skill: typeof usage.skill_key === 'string' ? usage.skill_key : usage.id,
    content_chars: result.content.length,
    content_digest: usage.content_digest,
    source: usage.id.startsWith('U') ? 'user' : 'builtin',
    ...(typeof usage.owner_fingerprint === 'string' ? { owner_fingerprint: usage.owner_fingerprint } : {}),
  }
}

/**
 * 可移植 Run 编排。DB/Redis、Provider wire、交互授权与调度均由显式端口注入。
 * 每次 yield 前都已提交 checkpoint/outbox；调用方停止消费自然形成背压。
 */
export function createAgentRunner<C>(ports: AgentRunnerPorts<C>): AgentRunner<C> {
  const active = new Map<string, AbortController>()
  const activeSessions = new Set<string>()
  const read = (identity: RunIdentity) => readRunCheckpoint(ports, identity)
  const publish = (event: RunEvent, signal?: AbortSignal) => publishRunEvent(ports, event, signal)
  const replay = (identity: RunIdentity, options?: { readonly signal?: AbortSignal }) => replayRunEvents(ports, read, identity, options)
  const observedAt = () => Date.parse(ports.clock.now()) || Date.now()
  const observePhase = (identity: RunIdentity, name: string, startedAt: number, round: number, status: string, attributes?: Readonly<Record<string, unknown>>) => {
    const endedAt = observedAt()
    recordAgentObservation(ports.observation, {
      identity, kind: 'context', name, at: endedAt, round,
      spanId: `${identity.runId}:phase:${name}:${startedAt}`,
      parentSpanId: identity.runId, status, startedAt, endedAt,
      durationMs: Math.max(0, endedAt - startedAt), attributes,
    })
  }
  const logRun = (identity: RunIdentity, level: 'info' | 'warn' | 'error', event: import('./logging.js').AgentRunLogEventName,
    round?: number, attributes?: Readonly<Record<string, string | number | boolean | null>>) => recordAgentRunLog(ports.log, {
    identity, at: observedAt(), level, event, ...(round === undefined ? {} : { round }), ...(attributes ? { attributes } : {}),
  })
  const recordToolSchemaFailure = (identity: RunIdentity, context: C | null, call: ToolCall, round: number,
    errorKind: string, error: unknown, parentSpanId: string): void => {
    let schema: unknown = null
    try { if (context !== null) schema = ports.toolSchemaSnapshot?.(context, call.name) ?? null } catch { /* Schema 观测失败不影响工具回执。 */ }
    logRun(identity, 'warn', 'agent.tools.schema_error', round, {
      errorCode: errorKind === 'parse_error' ? 'invalid_arguments' : 'tool_failed',
    })
    recordAgentObservation(ports.observation, {
      identity, kind: 'tool', name: `Tool schema error · ${call.name}`, at: observedAt(), round,
      spanId: `${parentSpanId}:schema-error`, parentSpanId, status: 'error',
      input: { tool_name: call.name, schema, arguments: call.input, error },
      output: { tool_name: call.name, error_kind: errorKind },
      attributes: { context_source: 'tool_schema_error', error_kind: errorKind, tool_name: call.name },
    })
  }
  const recordToolInvocation = (identity: RunIdentity, call: ToolCall, round: number,
    outcome: 'success' | 'error' | 'waiting' | 'unknown' | 'cancelled' | 'deferred' | 'invalid',
    startedAt?: number, attributes: Readonly<Record<string, string | number | boolean | null>> = {}) => {
    const endedAt = observedAt()
    const safeTool = /^[A-Za-z0-9_.:-]{1,120}$/.test(call.name) ? call.name : 'unknown_tool'
    const level = outcome === 'unknown' ? 'error' : outcome === 'error' || outcome === 'invalid' ? 'warn' : 'info'
    logRun(identity, level, 'agent.tools.invocation', round, {
      tool: safeTool, outcome,
      ...(startedAt === undefined ? {} : { durationMs: Math.max(0, endedAt - startedAt) }),
      ...attributes,
    })
  }
  const observeEvent = (event: RunEvent) => {
    const payload = event.payload
    if (event.type === 'run_started') {
      logRun(event.identity, 'info', 'agent.run.started')
      recordAgentObservation(ports.observation, {
        identity: event.identity, kind: 'run', name: 'started', at: observedAt(), spanId: event.identity.runId, status: 'running',
      })
    }
    else if (event.type === 'run_resumed') {
      logRun(event.identity, 'info', 'agent.run.resumed')
      recordAgentObservation(ports.observation, {
        identity: event.identity, kind: 'run', name: 'resumed', at: observedAt(), spanId: event.identity.runId, status: 'running',
      })
    }
    else if (event.type === 'round_start') recordAgentObservation(ports.observation, {
      identity: event.identity, kind: 'round', name: 'started', at: observedAt(), round: event.round,
      spanId: `${event.identity.runId}:round:${event.round}`, parentSpanId: event.identity.runId, status: 'running',
    })
    else if (event.type === 'round_end') recordAgentObservation(ports.observation, {
      identity: event.identity, kind: 'round', name: 'completed', at: observedAt(), round: event.round,
      spanId: `${event.identity.runId}:round:${event.round}`, parentSpanId: event.identity.runId, status: 'success',
      output: payload.text,
    })
    else if (event.type === 'token') recordAgentObservation(ports.observation, {
      identity: event.identity, kind: 'round', name: 'output_delta', at: observedAt(), round: event.round,
      spanId: `${event.identity.runId}:round:${event.round}`, output: payload.text,
    })
    else if (event.type === 'final') {
      const at = observedAt()
      const status = String(payload.status ?? 'unknown')
      const text = typeof payload.text === 'string' ? payload.text : ''
      const safeStatus = ['completed', 'failed', 'cancelled', 'unknown'].includes(status)
        ? status as 'completed' | 'failed' | 'cancelled' | 'unknown' : 'unknown'
      logRun(event.identity, safeStatus === 'failed' ? 'error' : 'info', 'agent.run.finished', event.round,
        { status: safeStatus })
      recordAgentObservation(ports.observation, {
        identity: event.identity, kind: 'run', name: 'finished', at, spanId: event.identity.runId,
        status, output: text,
        usage: payload.usage && typeof payload.usage === 'object' ? payload.usage as import('./models.js').Usage : undefined,
      })
      if (status === 'completed' || status === 'failed')
        recordAgentObservation(ports.observation, {
          identity: event.identity, kind: 'output', name: status === 'failed' ? 'Agent error' : 'Final response', at,
          startedAt: at, endedAt: at, durationMs: 0, spanId: `${event.identity.runId}:output`,
          parentSpanId: event.identity.runId, status: status === 'failed' ? 'error' : 'success',
          output: { text, ...(typeof payload.errorCode === 'string' ? { code: payload.errorCode } : {}) },
          attributes: { source: 'agent.run.finalization' },
        })
    }
  }
  async function* drive(identity: RunIdentity, fresh: boolean, resolution?: InteractionResolution, scheduled = false, anchorMessageId: string | null = null, goalMode = false, initialReplyChoice: ReplyChoice = 'disabled'): AsyncGenerator<RunEvent, RunCheckpoint<C>> {
    assertRunIdentity(identity)
    if (anchorMessageId !== null && !/^\d+$/.test(anchorMessageId))
      throw new AgentRunError('invalid_state', '消息顺序锚点无效')
    identity = Object.freeze({ ...identity })
    const identityKey = runIdentityKey(identity)
    const sessionKey = JSON.stringify([identity.ownerId, identity.sessionId])
    if (active.has(identityKey) || activeSessions.has(sessionKey))
      throw new AgentRunError('conflict', '该会话正在执行')
    const controller = new AbortController()
    active.set(identityKey, controller)
    activeSessions.add(sessionKey)
    let lease: Lease | null = null
    let unsubscribe: (() => void) | undefined
    let state: RunCheckpoint<C> | undefined
    let providerRecovery = !fresh
    let finalized = false
    let persistenceUncertain = false
    let lastProviderFailure: unknown
    function reportProviderFailure(error: unknown, contextOverflow: boolean) {
      if (!state) return
      lastProviderFailure = error
      const errorCode = ports.presentError(error).code
      const safeCode = /^[a-z][a-z0-9_.-]{0,63}$/i.test(errorCode) ? errorCode : 'provider_error'
      const diagnostic = providerFailureFields(error)
      const cancelled = diagnostic.providerErrorCode === 'cancelled'
      const roundSpanId = `${identity.runId}:round:${state.round}`
      recordAgentObservation(ports.observation, {
        identity, kind: 'provider', name: 'complete', at: observedAt(), round: state.round,
        spanId: `${roundSpanId}:provider`, parentSpanId: roundSpanId,
        status: cancelled ? 'cancelled' : 'error',
        attributes: { error_code: safeCode, context_overflow: contextOverflow, ...diagnostic },
      })
      logRun(identity, contextOverflow || cancelled ? 'warn' : 'error', 'agent.provider.error', state.round,
        { errorCode: safeCode, contextOverflow, ...diagnostic })
    }

    const dispatchedCalls = new Set<string>()
    const uncertainExecutions = new Set<string>()
    const dispatchKey = (call: ToolCall) => `${state?.round ?? 0}:${call.id}`
    async function commit(...args: Parameters<RunCoordination<C>['commit']>): Promise<RunEvent | null> {
      const [patch, type, payload = {}, history = null, interactionReceipt = null] = args
      if (!state || !lease)
        throw new AgentRunError('invalid_state', '运行尚未建立')
      try {
        await ports.leases.assert(identity, lease)
      }
      catch {
        throw new AgentRunError('lease_lost', '运行租约已失效')
      }
      let displayTimeline = patch.displayTimeline ?? state.displayTimeline
      const now = ports.clock.now()
      const roundId = `${identity.runId}:${patch.round ?? state.round}`
      let changed
      let artifactDisplay
      let sealedTools: readonly DisplayItem[] = []
      if (type === 'token' || type === 'round_end') {
        const active = [...displayTimeline].reverse().find((item) => item.kind === 'assistant' && item.runId === identity.runId && item.roundId === roundId)
        const text = type === 'token' ? (active?.text ?? '') + String(payload.text ?? '') : String(payload.text ?? '')
        if (text) {
          displayTimeline = updateDisplayItem(displayTimeline, { kind: 'assistant', runId: identity.runId, roundId, ...(active ? { eventId: active.eventId } : {}), text }, { anchorMessageId: state.anchorMessageId, now })
          changed = active ? displayTimeline.find((item) => item.eventId === active.eventId) : displayTimeline.at(-1)
        }
      }
      else if (type === 'tool_call' || type === 'tool_done' || type === 'interaction_required') {
        const toolCallId = String(payload.toolCallId ?? '')
        const toolName = typeof payload.name === 'string' ? payload.name : undefined
        const priorCall = state.calls.find(call => call.id === toolCallId)
        const toolInput = type === 'tool_call' && priorCall && !priorCall.parseError
          ? projectPersistentToolInput(priorCall.input, priorCall.name) : undefined
        const matches = (item: DisplayItem) => item.kind === 'tool' && item.runId === identity.runId
          && item.roundId === roundId && item.toolCallId === toolCallId
        const previous = displayTimeline.find(matches)
        const toolLabelOverride = toolName && !previous ? ports.toolLabelOverride?.(toolName) : undefined
        const shellActivity = (toolName ?? previous?.toolName) === 'shell'
          ? describeShellActivity(toolInput ?? previous?.toolInput, payload.result ?? previous?.toolResult) : undefined
        displayTimeline = updateDisplayItem(displayTimeline, {
          kind: 'tool', runId: identity.runId, roundId, toolCallId,
          ...(toolName ? { toolName } : {}),
          ...(toolLabelOverride ? { toolLabelOverride } : {}),
          ...(shellActivity ? { shellActivity } : {}),
          toolStatus: type === 'interaction_required' ? 'waiting' : String(payload.status ?? 'running'),
          ...(toolInput === undefined ? {} : { toolInput }),
          ...(payload.result === undefined ? {} : { toolResult: payload.result }),
        }, { anchorMessageId: state.anchorMessageId, now })
        changed = displayTimeline.find(matches)
      }
      else if (type === 'final') {
        const incomplete = patch.status === 'failed' || patch.status === 'unknown'
        const sealed = sealDisplayTimeline(displayTimeline, now, incomplete)
        sealedTools = sealed.filter((item, index) => item !== displayTimeline[index])
        displayTimeline = sealed
      }
      if (type === 'tool_done' && payload.artifact !== undefined) {
        const artifact = portableSnapshot(payload.artifact)
        const buttons = artifact !== null && typeof artifact === 'object' && !Array.isArray(artifact) && 'kind' in artifact && artifact.kind === 'link_buttons'
        displayTimeline = updateDisplayItem(displayTimeline, { kind: 'assistant', runId: identity.runId, roundId, text: '', ...(buttons ? { linkButtons: artifact } : { files: [artifact] }) }, { anchorMessageId: state.anchorMessageId, now })
        artifactDisplay = displayTimeline.at(-1)
      }
      const next = {
        ...state,
        ...patch,
        displayTimeline,
        identity,
        version: state.version + 1,
        sequence: state.sequence + (type ? 1 : 0),
      }
      assertRunCheckpoint(identity, next)
      assertRunTransition(state.status, next.status)
      if (next.context !== null)
        ports.context.assertIdentity(identity, next.context)
      const event = type ? Object.freeze({
        id: `${identity.runId}:${next.sequence}`,
        identity,
        sequence: next.sequence,
        round: next.round,
        type,
        payload: Object.freeze({ ...payload, ...(changed ? { display: changed } : {}), ...(artifactDisplay ? { artifactDisplay } : {}),
          ...(sealedTools.length ? { sealedTools } : {}) }),
      }) : null
      try {
        await ports.store.commit({ identity, expectedVersion: state.version, lease, checkpoint: next, events: event ? [event] : [], history, interactionReceipt })
      }
      catch (error) {
        if (error instanceof RunStoreRejected) {
          controller.abort()
          throw error
        }
        // 提交可能已完成；不得随后再次 finalization 或重放调用来掩盖未知结果。
        persistenceUncertain = true
        controller.abort()
        throw new AgentRunError('persistence_unknown', '运行提交结果未知，请重新查询状态', { cause: error })
      }
      const previousContext = state.context
      state = next
      if (patch.context !== undefined && patch.context !== null && patch.context !== previousContext) {
        const snapshot = ports.observationSnapshot?.(patch.context)
        if (snapshot !== undefined) recordAgentObservation(ports.observation, {
          identity, kind: 'context', name: 'Canonical context snapshot', at: observedAt(), round: next.round,
          spanId: `${identity.runId}:context:${next.version}`, parentSpanId: identity.runId,
          status: 'success', output: snapshot,
        })
      }
      if (event) observeEvent(event)
      if (event)
        await publish(event, controller.signal)
      return event
    }
    async function executeTool(call: ToolCall, resolving: InteractionResolution | null, signal = controller.signal, waitForCleanup = false): Promise<ToolResult> {
      if (signal.aborted)
        throw new AgentRunError('cancelled', '当前任务已取消')
      const startedAt = observedAt()
      const round = state!.round
      if (call.parseError) {
        logRun(identity, 'warn', 'agent.tools.dispatch_failed', state!.round, { errorCode: 'invalid_arguments' })
        recordToolInvocation(identity, call, round, 'invalid', startedAt, { executed: false, errorCode: 'invalid_arguments' })
        if (state!.context !== null)
          recordToolSchemaFailure(identity, state!.context, call, state!.round, 'parse_error',
            { parse_error: true, code: call.parseError }, `${identity.runId}:round:${state!.round}:tool:${call.id}`)
        recordAgentObservation(ports.observation, {
          identity, kind: 'tool', name: call.name, at: observedAt(), round: state!.round,
          spanId: `${identity.runId}:round:${state!.round}:tool:${call.id}`,
          parentSpanId: `${identity.runId}:round:${state!.round}`, status: 'invalid',
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
        dispatched = ports.tools.dispatch(call, {
          identity,
          loadedSkills: call.name !== 'use_skill' || state!.context === null ? undefined : await ports.context.loadedSkills?.(state!.context),
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
    async function rejectPendingOverflow() {
      if (!state?.overflowRecoveryPending)
        return null
      return commit({ overflowRecoveryPending: false }, 'compaction', { phase: 'completed', reason: 'provider_retry_failed', applied: false })
    }
    async function applyTool(call: ToolCall, result: ToolResult, advance = true, consumeInteractionId?: string): Promise<RunEvent> {
      if (!state || state.context === null)
        throw new AgentRunError('invalid_state', '运行上下文缺失')
      if (result.kind === 'unknown') {
        logRun(identity, 'error', 'agent.tools.dispatch_failed', state.round, { errorCode: 'result_unknown' })
        return finish('unknown', 'tool_result_unknown', '工具执行结果尚未确认，请查询后再继续。')
      }
      if (result.kind === 'waiting' && result.interaction.kind === 'confirmation' && state.resolution?.status === 'confirmed') {
        // 已消费的确认不能再次弹同一授权门，也不能把“仍被拦截”伪装成执行成功。
        return applyTool(call, { kind: 'completed', value: { status: 'error', code: 'confirmation_not_applied' }, successful: false, mutated: false }, advance, consumeInteractionId)
      }
      if (result.kind === 'waiting') {
        recordAgentObservation(ports.observation, {
          identity, kind: 'tool', name: call.name, at: observedAt(), round: state.round,
          spanId: `${identity.runId}:round:${state.round}:tool:${call.id}`,
          parentSpanId: `${identity.runId}:round:${state.round}`, status: 'waiting',
          output: { interaction: result.interaction.kind }, attributes: { toolCallId: call.id },
        })
        if (controller.signal.aborted)
          return applyTool(call, { kind: 'completed', value: { status: 'cancelled' }, successful: false, mutated: false }, advance, consumeInteractionId)
        let request = snapshotInteraction(result.interaction, call)
        if (state.resolution?.status === 'confirmed')
          request = { ...request, afterConfirmation: true }
        const context = await ports.context.afterTool(state.context, call, { kind: 'waiting', interaction: request }, state.round)
        const queue = state.queuedInteractions.filter((item) => item.id !== consumeInteractionId && item.toolCall.id !== call.id)
        return (await commit({
          context,
          queuedInteractions: advance ? [...queue, request] : [request, ...queue],
          callIndex: state.callIndex + (advance ? 1 : 0), replayCall: null, replayResultReady: false,
          inflightCall: null, inflightCalls: state.inflightCalls.filter((item) => item.id !== call.id), resolution: null,
        }, 'tool_done', { toolCallId: call.id, name: call.name, status: 'waiting' }))!
      }
      const context = await ports.context.afterTool(state.context, call, result, state.round)
      const storedResult = state.toolResults.find((item) => item.callId === call.id)?.result
      let artifact
      try {
        artifact = result.artifact === undefined ? undefined : normalizePersistentArtifact(storedResult?.kind === 'completed' ? storedResult.artifact : result.artifact)
      }
      catch {
        throw new ToolResultCheckpointUnavailable({ callId: call.id, successful: result.successful, mutated: result.mutated })
      }
      const isButtons = artifact !== undefined && artifact !== null && typeof artifact === 'object' && !Array.isArray(artifact) && 'kind' in artifact && artifact.kind === 'link_buttons'
      const resultStatus = result.value && typeof result.value === 'object' && 'status' in result.value && ['cancelled', 'deferred'].includes(String(result.value.status)) ? String(result.value.status) : result.successful ? 'success' : 'error'
      if (!result.successful && result.value && typeof result.value === 'object' && !Array.isArray(result.value)
        && '_schema_recovery' in result.value) {
        const recovery = (result.value as Record<string, unknown>)._schema_recovery
        if (recovery && typeof recovery === 'object' && !Array.isArray(recovery)
          && (recovery as Record<string, unknown>).needed === true)
          recordToolSchemaFailure(identity, state.context, call, state.round,
            String((recovery as Record<string, unknown>).reason ?? 'validation_error'), result.value,
            `${identity.runId}:round:${state.round}:tool:${call.id}`)
      }
      const skill = result.successful ? skillInjectionMetadata(result.value) : null
      if (skill)
        recordAgentObservation(ports.observation, {
          identity, kind: 'context', name: 'Skill context injected', at: observedAt(), round: state.round,
          spanId: `${identity.runId}:round:${state.round}:skill:${call.id}`,
          parentSpanId: `${identity.runId}:round:${state.round}:tool:${call.id}`, status: 'success',
          input: skill, output: { skill: skill.skill, content_digest: skill.content_digest },
          attributes: { context_source: 'skill_body', skill: skill.skill, action: 'loaded', source: skill.source },
        })
      if (!result.successful)
        logRun(identity, 'warn', 'agent.tools.dispatch_failed', state.round, { errorCode: 'tool_failed', executed: result.executed !== false, mutated: result.mutated })
      recordAgentObservation(ports.observation, {
        identity, kind: 'tool', name: call.name, at: observedAt(), round: state.round,
        spanId: `${identity.runId}:round:${state.round}:tool:${call.id}`,
        parentSpanId: `${identity.runId}:round:${state.round}`, status: resultStatus,
        output: result.value, attributes: { toolCallId: call.id, successful: result.successful, mutated: result.mutated },
      })
      const presented = projectPersistentToolResult(await ports.presentToolResult(result.value, { identity, round: state.round, call }), true)
      return (await commit({
        context,
        queuedInteractions: state.queuedInteractions.filter((item) => item.id !== consumeInteractionId),
        inflightCall: null,
        inflightCalls: state.inflightCalls.filter((item) => item.id !== call.id),
        callIndex: state.callIndex + (advance ? 1 : 0), replayCall: null, replayResultReady: false,
        resolution: null,
        completedToolCount: state.completedToolCount + (result.executed === false || resultStatus === 'cancelled' || resultStatus === 'deferred' ? 0 : 1),
        mutated: state.mutated || result.mutated,
        files: artifact === undefined || isButtons ? state.files : [...state.files, artifact],
        emptyRetries: result.successful ? 0 : state.emptyRetries,
        replyState: toolReplyProgress(state.replyState, result.successful),
      }, 'tool_done', { toolCallId: call.id, name: call.name, status: resultStatus, result: presented, ...(artifact === undefined ? {} : { artifact }) }))!
    }
    async function* dispatchRoundTools() {
      if (!state)
        throw new AgentRunError('invalid_state', '运行尚未建立')
      const known = (call: ToolCall) => state!.toolResults.some((item) => item.callId === call.id)
      for (const id of state.isolatedCallIds) {
        const call = state.calls.find((item) => item.id === id)!
        if (!state.displayTimeline.some((item) => item.kind === 'tool' && item.roundId === `${identity.runId}:${state!.round}` && item.toolCallId === id))
          yield (await commit({}, 'tool_call', { toolCallId: id, name: call.name, status: 'invalid' }))!
      }
      const parallel = state.calls.filter((call) => state!.parallelCallIds.includes(call.id) && !known(call))
      const roundId = `${identity.runId}:${state.round}`
      const toolStatuses = new Map(state.displayTimeline.filter(item => item.kind === 'tool' && item.roundId === roundId)
        .map(item => [item.toolCallId, item.toolStatus]))
      const started = new Set(state.inflightCalls.filter(call => toolStatuses.get(call.id) === 'running').map(call => call.id))
      // 旧 checkpoint 先登记整个批次，再逐个发布开始事件。仍排队的调用从未交给工具端口。
      for (const call of parallel.filter(call => started.has(call.id)))
        await cacheResult(call, await ports.tools.reconcile(call, { ...identity, roundId: `${identity.runId}:${state.round}` }))
      const ready = parallel.filter(call => !started.has(call.id))
      if (ready.length) {
        if (state.toolResults.some(item => item.result.kind === 'unknown')) {
          for (const call of ready) await cacheResult(call, stoppedResult(call, 'deferred'))
        } else {
          for (const call of ready) {
            if (!toolStatuses.has(call.id))
              yield (await commit({}, 'tool_call', { toolCallId: call.id, name: call.name, status: 'queued' }))!
          }
          const batchStartedAt = observedAt()
          let outcomes: readonly DispatchOutcome<ToolResult>[]
          try {
            outcomes = yield* parallelBatch(ready, state.parallelLimit!)
            const counts = outcomes.reduce((summary, outcome) => {
              if (outcome.status === 'error') summary.failed++
              else if (outcome.status === 'cancelled') summary.cancelled++
              else if (outcome.status === 'deferred') summary.deferred++
              else if (outcome.value.kind === 'waiting') summary.waiting++
              else if (outcome.value.kind === 'unknown') summary.unknown++
              else if (!outcome.value.successful) summary.failed++
              else summary.succeeded++
              return summary
            }, { succeeded: 0, failed: 0, cancelled: 0, deferred: 0, waiting: 0, unknown: 0 })
            const batchElapsedMs = Math.max(0, observedAt() - batchStartedAt)
            observePhase(identity, 'Parallel tool batch', batchStartedAt, state.round,
              counts.failed ? 'error' : counts.unknown ? 'unknown' : counts.cancelled ? 'cancelled' : 'success', {
              mode: 'parallel', calls: ready.length, isolatedInvalid: state.isolatedCallIds.length,
              reason: 'same_round_batch', ...counts,
            })
            logRun(identity, counts.failed || counts.unknown ? 'warn' : 'info', 'agent.tools.parallel_batch', state.round, {
              mode: 'parallel', reason: 'same_round_batch', elapsedMs: batchElapsedMs,
              isolatedInvalid: state.isolatedCallIds.length,
              calls: ready.length, succeeded: counts.succeeded, failed: counts.failed, cancelled: counts.cancelled,
              deferred: counts.deferred, waiting: counts.waiting, unknown: counts.unknown,
            })
          }
          catch (error) {
            observePhase(identity, 'Parallel tool batch', batchStartedAt, state.round,
              error instanceof AgentRunError && error.code === 'cancelled' ? 'cancelled' : 'error', { calls: ready.length })
            throw error
          }
          for (let index = 0;index < ready.length;index++) {
            const call = ready[index]!
            const outcome = outcomes[index]!
            if (outcome.status === 'error') {
              const code = ports.presentError(outcome.error).code
              logRun(identity, 'warn', 'agent.tools.dispatch_failed', state.round, {
                errorCode: code === 'upstream_failed' ? 'upstream_failed' : 'tool_failed',
              })
              recordAgentObservation(ports.observation, {
                identity, kind: 'tool', name: call.name, at: observedAt(), round: state.round,
                spanId: `${identity.runId}:round:${state.round}:tool:${call.id}:dispatch-error`,
                parentSpanId: `${identity.runId}:round:${state.round}:tool:${call.id}`, status: 'error',
                attributes: { toolCallId: call.id, errorCode: code },
              })
            }
            const result: ToolResult = outcome.status === 'completed' ? outcome.value
              : outcome.status === 'error' ? { kind: 'completed', value: { error: ports.presentError(outcome.error).code }, successful: false, mutated: false }
                : stoppedResult(call, outcome.status)
            await cacheResult(call, result)
          }
        }
      }
      const inline = state.parallelCallIds.length === 0 && state.toolResults.length === 0
      let serialWaiting = state.toolResults.some((item) => item.result.kind === 'unknown')
      const serialCallIds = [...state.serialCallIds]
      const serialRound = state.round
      const hasParallelCalls = state.parallelCallIds.length > 0
      const serialBatchStartedAt = serialCallIds.length > 1 ? observedAt() : null
      try {
        for (const id of serialCallIds) {
          const call = state.calls.find((item) => item.id === id)!
          const previous = state.toolResults.find((item) => item.callId === id)?.result
          if (previous) {
            if (call.name === 'shell' && previous.kind === 'waiting' && previous.interaction.kind === 'confirmation') return
            serialWaiting ||= previous.kind === 'waiting' || previous.kind === 'unknown'
            continue
          }
          let result: ToolResult
          if (serialWaiting || controller.signal.aborted)
            result = stoppedResult(call, 'deferred')
          else if (state.inflightCall?.id === call.id)
            result = await ports.tools.reconcile(call, { ...identity, roundId: `${identity.runId}:${state.round}` })
          else {
            yield (await commit({ inflightCall: call }, 'tool_call', { toolCallId: call.id, name: call.name, status: 'running' }))!
            try {
              await checkCancellation()
              result = await executeTool(call, null)
            }
            catch (error) {
              if (controller.signal.aborted || (error instanceof AgentRunError && error.code === 'cancelled')) {
                controller.abort()
                result = stoppedResult(call, dispatchedCalls.has(dispatchKey(call)) ? 'cancelled' : 'deferred')
              }
              else
                result = { kind: 'completed', value: { error: ports.presentError(error).code }, successful: false, mutated: false }
            }
          }
          const cached = await cacheResult(call, result)
          serialWaiting ||= cached.kind === 'waiting' || cached.kind === 'unknown'
          if (inline) {
            yield await applyTool(call, cached)
            if (terminalRunStates.has(state.status))
              return
          }
          // Shell 保持串行；确认重投完成后再派发剩余调用，保留各自的确认门。
          if (call.name === 'shell' && cached.kind === 'waiting' && cached.interaction.kind === 'confirmation') return
        }
      }
      finally {
        if (serialBatchStartedAt !== null) {
          const elapsedMs = Math.max(0, observedAt() - serialBatchStartedAt)
          const currentState = state
          const results = currentState?.toolResults.filter(item => serialCallIds.includes(item.callId)) ?? []
          const counts = results.reduce((summary, item) => {
            const kind = item.result.kind
            if (kind === 'waiting') summary.waiting++
            else if (kind === 'unknown') summary.unknown++
            else if (kind === 'completed') item.result.successful ? summary.succeeded++ : summary.failed++
            else if (kind === 'cancelled') summary.cancelled++
            else if (kind === 'deferred') summary.deferred++
            else summary.failed++
            return summary
          }, { succeeded: 0, failed: 0, cancelled: 0, deferred: 0, waiting: 0, unknown: 0 })
          const status = counts.failed ? 'error' : counts.unknown ? 'unknown' : counts.cancelled ? 'cancelled' : 'success'
          const reason = hasParallelCalls ? 'mixed_batch' : 'parallel_disabled'
          observePhase(identity, 'Serial tool batch', serialBatchStartedAt, serialRound, status, {
            mode: 'serial', calls: serialCallIds.length, reason, elapsedMs, ...counts,
          })
          logRun(identity, counts.failed || counts.unknown ? 'warn' : 'info', 'agent.tools.serial_batch', serialRound, {
            mode: 'serial', reason, elapsedMs, calls: serialCallIds.length, ...counts,
          })
        }
      }
      await commit({ toolsDispatched: true })
    }
    const checkCancellation = (...args: Parameters<RunCoordination<C>['checkCancellation']>) => checkCancellationForRun(scope, ...args)
    const finish = (...args: Parameters<RunCoordination<C>['finish']>) => finishForRun(scope, ...args)
    const activateNextInteraction = (...args: Parameters<RunCoordination<C>['activateNextInteraction']>) => activateNextInteractionForRun(scope, ...args)
    const closeInteractions = (...args: Parameters<RunCoordination<C>['closeInteractions']>) => closeInteractionsForRun(scope, ...args)
    const completeResolutionClosure = (...args: Parameters<RunCoordination<C>['completeResolutionClosure']>) => completeResolutionClosureForRun(scope, ...args)
    const parallelBatch = (...args: Parameters<RunCoordination<C>['parallelBatch']>) => parallelBatchForRun(scope, ...args)
    const encodeResult = (...args: Parameters<RunCoordination<C>['encodeResult']>) => encodeResultForRun(scope, ...args)
    const hydrateResult = (...args: Parameters<RunCoordination<C>['hydrateResult']>) => hydrateResultForRun(scope, ...args)
    const cacheResult = (...args: Parameters<RunCoordination<C>['cacheResult']>) => cacheResultForRun(scope, ...args)
    const stoppedResult = (...args: Parameters<RunCoordination<C>['stoppedResult']>) => stoppedResultForRun(scope, ...args)
    const closeTools = (...args: Parameters<RunCoordination<C>['closeTools']>) => closeToolsForRun(scope, ...args)
    const scope: RunCoordination<C> = {
      ports, identity, controller,
      get state() { return state },
      set state(value) { state = value },
      get lease() { return lease },
      set lease(value) { lease = value },
      get finalized() { return finalized },
      set finalized(value) { finalized = value },
      get persistenceUncertain() { return persistenceUncertain },
      set persistenceUncertain(value) { persistenceUncertain = value },
      dispatchedCalls, uncertainExecutions, dispatchKey,
      commit, checkCancellation, finish, executeTool, applyTool,
      activateNextInteraction, closeInteractions, completeResolutionClosure,
      parallelBatch, encodeResult, hydrateResult, cacheResult, stoppedResult, closeTools,
    }
    try {
      lease = await ports.leases.acquire(identity)
      if (!lease)
        throw new AgentRunError('conflict', '该运行正在执行')
      unsubscribe = await ports.cancellation.subscribe(identity, () => controller.abort())
      if (fresh) {
        if (await ports.store.read(identity))
          throw new AgentRunError('conflict', '运行已存在')
        state = {
          identity, version: 0, sequence: 1, status: 'preparing', phase: 'prepare', round: 0,
          context: null, text: '', roundTexts: [], displayTimeline: [], anchorMessageId, usage: emptyRunUsage, totalUsage: emptyRunUsage, usageAppliedRound: -1, providerCursor: null, sanitizerCheckpoint: { kind: 'clean' }, mutated: false, unpersistedToolResult: null, files: [], providerRounds: [], calls: [], callIndex: 0,
          inflightCall: null, inflightCalls: [], parallelLimit: null, pending: null, queuedInteractions: [], replayCall: null, replayResultReady: false, toolResults: [], toolsDispatched: false, parallelCallIds: [], serialCallIds: [], isolatedCallIds: [], resolution: null, resolutionClosure: null, emptyRetries: 0, replyState: initialReplyState, overflowRetries: 0, overflowRecoveryPending: false,
          maxRounds: scheduled ? 100 : null, goalMode, replyChoice: initialReplyChoice, roundRequiresTools: false, completedToolCount: 0, remoteStatusUnknown: false, errorCode: null, earlyExitReason: null,
        }
        const event: RunEvent = { id: `${identity.runId}:1`, identity, sequence: 1, round: 0, type: 'run_started', payload: {} }
        try {
          await ports.store.create(state, lease, [event])
        }
        catch (error) {
          if (error instanceof RunStoreRejected) {
            controller.abort()
            throw error
          }
          persistenceUncertain = true
          throw new AgentRunError('persistence_unknown', '运行创建结果未知，请重新查询状态', { cause: error })
        }
        observeEvent(event)
        await publish(event, controller.signal)
        yield event!
      }
      else {
        state = await read(identity)
        for await (const event of replay(identity, { signal: controller.signal }))
          yield event!
        if (terminalRunStates.has(state.status)) {
          finalized = true
          return state
        }
        if (state.resolutionClosure) {
          yield* completeResolutionClosure()
          return state
        }
        if (state.status === 'waiting') { const stopped = yield* resumeWaitingRun(scope, resolution); if (stopped) return state }
        yield (await commit({}, 'run_resumed'))!
      }
      while (!terminalRunStates.has(state.status) && state.status !== 'waiting') {
        if (state.phase === 'tools') {
          try {
            await checkCancellation()
          }
          catch (error) {
            if (!(error instanceof AgentRunError && error.code === 'cancelled'))
              throw error
          }
        }
        else
          await checkCancellation()
        if (state.phase === 'prepare') {
          const prepareStartedAt = observedAt()
          let context: Awaited<ReturnType<typeof ports.context.prepare>>
          try {
            context = await cancellable(ports.context.prepare(identity, controller.signal), controller.signal)
            observePhase(identity, 'Agent context prepared', prepareStartedAt, state.round, 'success', {
              earlyExit: isEarlyExit(context),
            })
          }
          catch (error) {
            observePhase(identity, 'Agent context prepared', prepareStartedAt, state.round,
              error instanceof AgentRunError && error.code === 'cancelled' ? 'cancelled' : 'error')
            throw error
          }
          if (isEarlyExit(context)) {
            await commit({ earlyExitReason: context.reason })
            const code = context.response.errored ? context.response.errorCode && /^[a-z][a-z0-9_.-]{0,63}$/i.test(context.response.errorCode) ? context.response.errorCode : 'provider_error' : null
            yield await finish(context.response.errored ? 'failed' : 'completed', code, ports.sanitizeText(context.response.text))
            return state
          }
          await commit({ context, status: 'running', phase: 'idle' })
          continue
        }
        if (state.context === null)
          throw new AgentRunError('invalid_state', '运行上下文缺失')
        if (state.phase === 'tools') {
          if (state.replayCall) {
            const call = state.replayCall
            await checkCancellation()
            let result: ToolResult
            if (state.replayResultReady) {
              const stored = state.toolResults.find((item) => item.callId === call.id)?.result
              if (!stored) {
                logRun(identity, 'error', 'agent.interaction.result_missing', state.round)
                throw new AgentRunError('invalid_state', '确认工具回执缺失')
              }
              result = await hydrateResult(call, stored)
            }
            else if (state.inflightCall) {
              result = await ports.tools.reconcile(call, { ...identity, roundId: `${identity.runId}:${state.round}` })
              await cacheResult(call, result, true)
            }
            else {
              yield (await commit({ inflightCall: call }, 'tool_call', { toolCallId: call.id, name: call.name, status: 'running' }))!
              await checkCancellation()
              try {
                result = await executeTool(call, state.resolution)
              }
              catch (error) {
                if (controller.signal.aborted || (error instanceof AgentRunError && error.code === 'cancelled'))
                  throw error
                logRun(identity, 'error', 'agent.interaction.confirm_replay_failed', state.round)
                result = { kind: 'completed', value: { status: 'error', code: ports.presentError(error).code }, successful: false, mutated: false }
              }
              await cacheResult(call, result, true)
            }
            const received = snapshotToolResult(result, call)
            yield await applyTool(call, received, false)
            if (terminalRunStates.has(state.status))
              return state
            if (state.pending)
              return state
            const next = await activateNextInteraction()
            if (next)
              yield next
            if (state.pending)
              return state
            continue
          }
          if (!state.toolsDispatched)
            yield* dispatchRoundTools()
          while (state.callIndex < state.calls.length && !terminalRunStates.has(state.status)) {
            const call = state.calls[state.callIndex]!
            const stored = state.toolResults.find((item) => item.callId === call.id)?.result
            if (!stored) {
              if (!state.toolsDispatched && state.queuedInteractions.some(item =>
                item.kind === 'confirmation' && item.toolCall.name === 'shell')) break
              throw new AgentRunError('invalid_state', '工具收据缺失')
            }
            yield await applyTool(call, await hydrateResult(call, stored))
          }
          if (terminalRunStates.has(state.status))
            return state
          if (controller.signal.aborted)
            throw new AgentRunError('cancelled', '当前任务已取消')
          if (state.replyChoice === 'silent') {
            yield await finish('completed', null, '', true)
            return state
          }
          if (state.pending)
            return state
          const activated = await activateNextInteraction()
          if (activated)
            yield activated
          if (state.pending)
            return state
          if (state.callIndex >= state.calls.length) {
            if (state.calls.length > 0) {
              const transitionAt = observedAt()
              const nextRound = state.round + 1
              logRun(identity, 'info', 'agent.run.continued', state.round, {
                reason: 'tool_round', nextRound, toolCount: state.calls.length,
              })
              recordAgentObservation(ports.observation, {
                identity, kind: 'state', name: 'Continue after tool round', at: transitionAt,
                startedAt: transitionAt, endedAt: transitionAt, durationMs: 0,
                spanId: `${identity.runId}:state:continue-after-tool-round:${state.round}`,
                parentSpanId: identity.runId, status: 'success',
                input: { round: state.round, tool_call_count: state.calls.length },
                output: { next_round: nextRound },
                attributes: { reason: 'tool_round' },
              })
            }
            await commit({ phase: 'idle', calls: [], callIndex: 0, inflightCall: null, inflightCalls: [], parallelLimit: null, toolResults: [], toolsDispatched: false, parallelCallIds: [], serialCallIds: [], isolatedCallIds: [] })
            continue
          }
          continue
        }
        if (state.phase === 'decision') {
          const rawText = ports.sanitizeText(state.text).trim()
          const text = stripGoalMarker(rawText).trim()
          if (state.goalMode) {
            if (text) {
              yield (await commit({ roundTexts: [...state.roundTexts, text] }, 'token', { text }))!
              yield (await commit({}, 'round_end', { text }))!
            }
            if (!goalCompleted(rawText)) {
              if (!ports.context.appendReminder)
                throw new AgentRunError('invalid_state', '目标续轮提醒端口缺失')
              const context = await ports.context.appendReminder(state.context, '目标尚未完成。继续执行剩余步骤；只有完整目标全部完成后，才输出内部完成标记。')
              await commit({ context, phase: 'idle' })
              continue
            }
          }
          if (ports.reply.classify) {
            const facts = await ports.reply.classify(text, state.context, { requiresTools: state.roundRequiresTools })
            const decision = decideReply(state.replyState, facts)
            if (decision.action === 'retry') {
              let context: C = state.context
              if (decision.prompt) {
                if (!ports.context.appendReminder)
                  throw new AgentRunError('invalid_state', '回复守卫提醒端口缺失')
                context = await ports.context.appendReminder(context, decision.prompt)
              }
              await commit({ context, phase: 'idle', replyState: decision.state, emptyRetries: decision.state.emptyRetries })
              continue
            }
            const accepted = decision.visible === 'fallback' ? facts.emptyFallback : decision.visible === 'suppressed' ? '' : text
            if (accepted && (decision.visible === 'fallback' || (state.replyState.guardPending && !state.goalMode))) {
              yield (await commit({ roundTexts: [...state.roundTexts, accepted] }, 'token', { text: accepted }))!
              yield (await commit({}, 'round_end', { text: accepted }))!
            }
            await commit({ replyState: decision.state })
            yield await finish('completed', null, accepted)
            return state
          }
          const decision = text ? await ports.reply.evaluate(text, state.context) : 'retry'
          if (decision === 'accept' || decision === 'silent') {
            yield await finish('completed', null, decision === 'silent' ? '' : text, decision === 'silent')
            return state
          }
          if (state.emptyRetries >= 2) {
            if (!text) {
              const fallback = '嗯…我这下没太接住，你再说一遍、或者换个说法，我马上跟上～'
              yield (await commit({ roundTexts: [...state.roundTexts, fallback] }, 'token', { text: fallback }))!
              yield (await commit({}, 'round_end', { text: fallback }))!
              yield await finish('completed', null, fallback)
            }
            else
              yield await finish('failed', 'incomplete_reply', '工具结果已返回，但后续回复没有完成，请重试。')
            return state
          }
          await commit({ phase: 'idle', emptyRetries: state.emptyRetries + 1 })
          continue
        }
        if (state.phase === 'idle') {
          if (state.maxRounds !== null && state.round >= state.maxRounds) {
            logRun(identity, 'warn', 'agent.run.round_limit', state.round, { used: state.round, limit: state.maxRounds })
            yield await finish('failed', 'round_limit', '定时任务已达到执行轮次上限。')
            return state
          }
          yield (await commit({ phase: 'provider', round: state.round + 1, text: '', usage: emptyRunUsage, providerCursor: null, sanitizerCheckpoint: { kind: 'clean' } }, 'round_start'))!
          providerRecovery = false
        }
        const providerLifetime = providerStreamLifetime(controller.signal)
        const request = { identity, round: state.round, context: state.context, signal: providerLifetime.signal, replyChoice: state.replyChoice }
        const sanitizer = ports.createStreamSanitizer({ identity, round: state.round })
        let sanitizerTouched = false
        let sanitizerFlushed = false
        const captureSanitizer = (): SanitizerCheckpoint => sanitizerFlushed || !sanitizerTouched ? { kind: 'clean' } : sanitizerCheckpoint(sanitizer)
        let stream
        let recovering = false
        if (providerRecovery) {
          const recoveryStartedAt = observedAt()
          const boundary = Object.freeze({
            identity, round: state.round, runSequence: state.sequence, roundText: state.text,
            cursor: state.providerCursor ? snapshotCursor(state.providerCursor) : null, sanitizer: Object.freeze({ ...state.sanitizerCheckpoint }),
          })
          const recoverable = state.sanitizerCheckpoint.kind !== 'unavailable' && (state.sanitizerCheckpoint.kind !== 'reference' || !!sanitizer.restore) && (state.providerCursor !== null || !state.text)
          try {
            const recovery = recoverable && ports.provider.recover ? await cancellable(ports.provider.recover!(request, boundary), controller.signal) : null
            if (recovery?.boundary && sameRecoveryBoundary(boundary, recovery.boundary)) {
              if (state.sanitizerCheckpoint.kind === 'reference') {
                await sanitizer.restore!(state.sanitizerCheckpoint, { identity, round: state.round })
                sanitizerTouched = true
              }
              stream = recovery.stream
              recovering = true
            }
            else
              stream = null
            observePhase(identity, 'Provider round resumed', recoveryStartedAt, state.round,
              stream ? 'success' : 'unknown', { recovered: !!stream })
          }
          catch (error) {
            observePhase(identity, 'Provider round resumed', recoveryStartedAt, state.round,
              error instanceof AgentRunError && error.code === 'cancelled' ? 'cancelled' : 'error')
            throw error
          }
          providerRecovery = false
          if (!stream) {
            providerLifetime.abort()
            const rejected = await rejectPendingOverflow()
            if (rejected)
              yield rejected
            yield await finish('unknown', 'provider_result_unknown', '上一次模型请求的结果尚未确认，请重新查询运行状态。')
            return state
          }
        }
        else
          stream = ports.provider.stream(request)
        const iterator = stream[Symbol.asyncIterator]()
        let complete = false
        let overflow = false
        try {
          while (true) {
            const next = await cancellable(iterator.next(), controller.signal)
            if (next.done)
              break
            const item = next.value
            const cursor = item.cursor ? snapshotCursor(item.cursor) : null
            if (cursor && state.providerCursor) {
              if (cursor.sequence < state.providerCursor.sequence || cursor.sequence === state.providerCursor.sequence && cursor.reference === state.providerCursor.reference)
                continue
            }
            if ((cursor && cursor.sequence !== (state.providerCursor?.sequence ?? 0) + 1) || (recovering && !cursor)) {
              const rejected = await rejectPendingOverflow()
              if (rejected)
                yield rejected
              yield await finish('unknown', 'provider_resume_gap', '模型续接事件不完整，未继续执行工具，请重新查询运行状态。')
              return state
            }
            const streamPatch = () => ({ providerCursor: cursor ?? state!.providerCursor, sanitizerCheckpoint: captureSanitizer() })
            if (item.type === 'token') {
              sanitizerTouched = true
              const text = sanitizer.feed(item.text)
              if (text) {
                if (state.goalMode || state.replyState.guardPending || state.replyChoice === 'pending')
                  await commit({ ...streamPatch(), text: state.text + text })
                else
                  yield (await commit({ ...streamPatch(), text: state.text + text }, 'token', { text }))!
              }
              else
                await commit(streamPatch())
            }
            else if (item.type === 'usage') {
              if (![item.usage.input, item.usage.output, item.usage.cacheRead, item.usage.cacheWrite, ...(item.usage.contextInput === null ? [] : [item.usage.contextInput])].every((value) => Number.isSafeInteger(value) && value >= 0)) {
                throw new AgentRunError('invalid_state', '模型用量数据无效')
              }
              recordAgentObservation(ports.observation, {
                identity, kind: 'provider', name: 'usage', at: observedAt(), round: state.round,
                spanId: `${identity.runId}:round:${state.round}:provider`,
                parentSpanId: `${identity.runId}:round:${state.round}`, status: 'success', usage: item.usage,
              })
              await commit({ ...streamPatch(), usage: item.usage })
            }
            else if (item.type === 'diagnostic') {
              const diagnostic = projectProviderDiagnostic(item.data)
              yield (await commit({ ...streamPatch(), providerRounds: [...state.providerRounds, diagnostic] }, 'provider_diagnostic', diagnostic))!
            }
            else if (item.type === 'retry') {
              if (!Number.isSafeInteger(item.attempt) || item.attempt < 1 || !Number.isSafeInteger(item.maxRetries) || item.maxRetries < item.attempt || !Number.isSafeInteger(item.nextRetryMs) || item.nextRetryMs < 0)
                throw new AgentRunError('invalid_state', '模型重试事件无效')
              const errorCode = ['rate_limited', 'timeout', 'transport', 'upstream_busy'].includes(item.errorCode) ? item.errorCode : 'unknown'
              logRun(identity, 'info', 'agent.provider.retry', state.round, { attempt: item.attempt, maxRetries: item.maxRetries, nextRetryMs: item.nextRetryMs, errorCode })
              yield (await commit(streamPatch(), 'retry', { attempt: item.attempt, maxRetries: item.maxRetries, nextRetryMs: item.nextRetryMs, errorCode }))!
            }
            else if (item.type === 'error') {
              reportProviderFailure(item.error, item.contextOverflow === true)
              if (item.contextOverflow && state.overflowRetries < 1) {
                overflow = true
                break
              }
              throw item.error
            }
            else {
              if (complete)
                throw new AgentRunError('invalid_state', '模型轮次重复结束')
              const incomplete = !!(item.incompleteReason ?? '').trim() || ['length', 'max_tokens', 'incomplete'].includes((item.finishReason ?? '').toLowerCase())
              const finishReason = (item.finishReason ?? '').toLowerCase()
              const incompleteReason = (item.incompleteReason ?? '').toLowerCase()
              const safeFinishReason = ['stop', 'end_turn', 'tool_calls', 'tool_use', 'length', 'max_tokens', 'incomplete', 'failed', 'content_filter'].includes(finishReason) ? finishReason : 'unknown'
              const safeIncompleteReason = ['max_output_tokens', 'content_filter', 'unknown'].includes(incompleteReason) ? incompleteReason : incompleteReason ? 'other' : ''
              const hasText = !!item.text.trim()
              const requiresTools = item.requiresTools ?? item.calls.length > 0
              recordAgentObservation(ports.observation, {
                identity, kind: 'provider', name: 'complete', at: observedAt(), round: state.round,
                spanId: `${identity.runId}:round:${state.round}:provider`,
                parentSpanId: `${identity.runId}:round:${state.round}`, status: incomplete ? 'incomplete' : 'success',
                output: item.text,
                attributes: { finish_reason: safeFinishReason, incomplete_reason: safeIncompleteReason, has_text: hasText, tool_call_count: item.calls.length },
              })
              logRun(identity, 'info', 'agent.provider.round_result', state.round, {
                toolCallCount: item.calls.length, hasText, requiresTools, goalMode: state.goalMode,
                toolCallsUsed: state.completedToolCount, outputTokens: state.usage.output,
              })
              if (incomplete)
                logRun(identity, 'warn', 'agent.provider.incomplete', state.round, {
                  finishReason: safeFinishReason, incompleteReason: safeIncompleteReason || 'unknown', hasText,
                  toolCallCount: item.calls.length, outputTokens: state.usage.output,
                })
              else if (!hasText && !item.calls.length)
                logRun(identity, 'warn', 'agent.provider.empty', state.round, { finishReason: safeFinishReason })
              complete = true
              if (state.usageAppliedRound !== state.round)
                await commit({ totalUsage: mergeUsage(state.totalUsage, state.usage), usageAppliedRound: state.round })
              if (state.overflowRecoveryPending)
                yield (await commit({ overflowRecoveryPending: false }, 'compaction', { phase: 'completed', reason: 'provider_overflow', applied: true }))!
              if (incomplete) {
                yield await finish('failed', 'provider_incomplete', item.calls.length ? '模型响应不完整，未执行其中的工具调用。请缩短请求或调高输出 Token 预算后重试。' : '模型输出未完整结束；当前内容可能被截断，请继续追问或调高输出 Token 预算。')
                return state
              }
              const wireCalls = Object.freeze(item.calls.map(snapshotToolCall))
              const ids = new Set<string>()
              for (const call of wireCalls) {
                if (!call.id || !call.name || ids.has(call.id))
                  throw new AgentRunError('invalid_state', '工具调用身份无效')
                ids.add(call.id)
              }
              const unavailableIds = new Set(wireCalls.filter(call =>
                ports.context.isRoundToolAvailable?.(request.context, call.name) === false).map(call => call.id))
              const adapterResults: { callId: string; result: ToolResult }[] = []
              const calls = Object.freeze(await Promise.all(wireCalls.map(async call => {
                if (unavailableIds.has(call.id)) {
                  adapterResults.push({ callId: call.id, result: {
                    kind: 'completed', successful: false, mutated: false, executed: false,
                    value: { error: '工具不存在或未开放', next_action: '请从当前工具目录选择已开放的工具，勿重复调用此工具。' },
                  } })
                  return call
                }
                if (call.name !== 'call_tool' || !ports.tools.resolveCall) return call
                const target = await ports.tools.resolveCall(call, identity, controller.signal)
                if ('call' in target) return snapshotToolCall(target.call)
                adapterResults.push({ callId: call.id, result: rejectAdapterCall(target.error) })
                return call
              })))
              const tail = sanitizer.flush()
              sanitizerFlushed = true
              if (tail) {
                if (state.goalMode || state.replyState.guardPending || state.replyChoice === 'pending')
                  await commit({ text: state.text + tail, sanitizerCheckpoint: captureSanitizer() })
                else
                  yield (await commit({ text: state.text + tail, sanitizerCheckpoint: captureSanitizer() }, 'token', { text: tail }))!
              }
              const text = ports.sanitizeText(item.text).trim()
              let gate: { choice: ReplyChoice; blocked: readonly { readonly id: string; readonly code: string }[] } = { choice: state.replyChoice, blocked: [] }
              let gateCalls: { id: string; kind: ReplyGateCall }[] = []
              if (state.replyChoice !== 'disabled') {
                if (!ports.replyGate)
                  throw new AgentRunError('invalid_state', '群回复门策略端口缺失')
                gateCalls = await Promise.all(calls.map(async (call) => ({ id: call.id, kind: unavailableIds.has(call.id) ? 'invalid' as const : await ports.replyGate!.classifyCall(state!.context!, call) })))
                if (gateCalls.some((call) => !['decline', 'business', 'invalid'].includes(call.kind)))
                  throw new AgentRunError('invalid_state', '群回复门调用分类无效')
                gate = decideReplyGate(state.replyChoice, text, gateCalls)
              }
              if (gate.blocked.length)
                logRun(identity, 'warn', 'agent.reply_gate.blocked', state.round, { count: gate.blocked.length, choice: gate.choice })
              const roundContextStartedAt = observedAt()
              let context: C
              try {
                context = await ports.context.afterRound(state.context, { text, calls: wireCalls, contextInput: state.usage.contextInput, ...(item.continuation === undefined ? {} : { continuation: item.continuation }), ...(item.cacheAnchor === undefined ? {} : { cacheAnchor: portableSnapshot(item.cacheAnchor) }), ...(item.consumedInitialMedia === undefined ? {} : { consumedInitialMedia: portableSnapshot(item.consumedInitialMedia) as unknown as typeof item.consumedInitialMedia }) }, state.round)
                observePhase(identity, 'Round context and tool schemas refreshed', roundContextStartedAt, state.round, 'success', {
                  toolCalls: wireCalls.length,
                })
              }
              catch (error) {
                observePhase(identity, 'Round context and tool schemas refreshed', roundContextStartedAt, state.round,
                  error instanceof AgentRunError && error.code === 'cancelled' ? 'cancelled' : 'error', { toolCalls: wireCalls.length })
                throw error
              }
              const plannable = calls.filter(call => !adapterResults.some(item => item.callId === call.id))
              let plan: ToolPlan = plannable.length && ports.tools.plan && gate.choice !== 'silent' ? await ports.tools.plan(plannable, identity) : { mode: 'serial' }
              const gateResults = calls.flatMap<{ callId: string; result: ToolResult }>((call) => {
                if (unavailableIds.has(call.id)) return []
                const blocked = gate.blocked.find((item) => item.id === call.id)
                if (blocked)
                  return [{ callId: call.id, result: { kind: 'completed', value: { error: blocked.code }, successful: false, mutated: false, executed: false } }]
                if (gate.choice === 'silent' && gateCalls.find((item) => item.id === call.id)?.kind === 'decline')
                  return [{ callId: call.id, result: { kind: 'completed', value: { status: 'silent' }, successful: true, mutated: false, executed: false } }]
                if (gate.choice === 'silent')
                  return [{ callId: call.id, result: { kind: 'completed', value: { error: 'tool_call_invalid' }, successful: false, mutated: false, executed: false } }]
                return []
              })
              if (gateResults.length)
                plan = { ...plan, isolatedResults: [...(plan.isolatedResults ?? []).filter((item) => !gateResults.some((gate) => gate.callId === item.callId)), ...gateResults], ...(plan.mode === 'parallel' ? { serialCallIds: (plan.serialCallIds ?? []).filter((id) => !gateResults.some((gate) => gate.callId === id)) } : {}) }
              if (adapterResults.length)
                plan = { ...plan, isolatedResults: [...(plan.isolatedResults ?? []), ...adapterResults.filter(item => !gateResults.some(gate => gate.callId === item.callId))] }
              const partition = partitionToolPlan(calls, plan)
              for (let index = 0;index < partition.toolResults.length;index++) {
                const item = partition.toolResults[index]!
                const call = calls.find((call) => call.id === item.callId)!
                partition.toolResults[index] = { callId: item.callId, result: await encodeResult(call, item.result) }
              }
              const buffered = state.goalMode || state.replyState.guardPending || gate.choice === 'silent' || gate.choice === 'pending'
              if (state.replyChoice === 'pending' && gate.choice === 'reply' && text && !state.goalMode && !state.replyState.guardPending)
                yield (await commit({}, 'token', { text }))!
              const ended = await commit({
                context, text, calls, callIndex: 0, phase: calls.length ? 'tools' : 'decision',
                ...streamPatch(),
                replyChoice: gate.choice,
                roundRequiresTools: item.requiresTools ?? calls.length > 0,
                replyState: calls.length ? toolReplyProgress(state.replyState) : state.replyState,
                ...partition, toolsDispatched: false, queuedInteractions: [], replayCall: null,
                roundTexts: text && !buffered ? [...state.roundTexts, text] : state.roundTexts,
              }, buffered ? undefined : 'round_end', { text })
              if (ended)
                yield ended
              break
            }
          }
        }
        finally {
          // 先中止本轮网络再等待回收。它与Run取消信号分离，清理异常不会冒充用户取消。
          const closing = providerLifetime.close(iterator)
          if (closing) await closing
        }
        // 合作式 Provider 会在取消后直接结束流；这仍然是取消，不能误判续轮截断。
        if (controller.signal.aborted)
          throw new AgentRunError('cancelled', '当前任务已取消')
        if (overflow) {
          yield (await commit({ overflowRecoveryPending: true }, 'compaction', { phase: 'started', reason: 'provider_overflow' }))!
          await checkCancellation()
          const compactionStartedAt = observedAt()
          let recovered: Awaited<ReturnType<typeof ports.context.recoverOverflow>>
          try {
            recovered = await ports.context.recoverOverflow(state.context, state.overflowRetries + 1, controller.signal)
            observePhase(identity, 'Context overflow recovery', compactionStartedAt, state.round,
              recovered.applied ? 'success' : 'skipped', { applied: recovered.applied, attempt: state.overflowRetries + 1 })
            logRun(identity, recovered.applied ? 'info' : 'warn', 'agent.context.overflow_recovery', state.round,
              { applied: recovered.applied, attempt: state.overflowRetries + 1 })
          }
          catch (error) {
            observePhase(identity, 'Context overflow recovery', compactionStartedAt, state.round,
              error instanceof AgentRunError && error.code === 'cancelled' ? 'cancelled' : 'error', { attempt: state.overflowRetries + 1 })
            throw error
          }
          if (!recovered.applied) {
            if (recovered.context !== state.context)
              await commit({ context: recovered.context })
            yield (await commit({ overflowRecoveryPending: false }, 'compaction', { phase: 'completed', reason: 'not_applied', applied: false }))!
            yield await finish('failed', 'context_overflow', '当前上下文过长，无法继续本次请求。')
            return state
          }
          await commit({ context: recovered.context, overflowRetries: state.overflowRetries + 1, overflowRecoveryPending: true, phase: 'idle', round: state.round - 1 })
          continue
        }
        if (!complete) {
          const rejected = await rejectPendingOverflow()
          if (rejected)
            yield rejected
          yield await finish('failed', 'incomplete_continuation', '工具结果已返回，但后续回复没有完成，请重试。')
          return state
        }
        // 仅按本次 provider 实际用量决定压缩，不能拿字符或累计token推算。
        if (state.usage.contextInput !== null) {
          const compactionStartedAt = observedAt()
          const before = contextSummaryMetrics(ports.observationSnapshot?.(state.context))
          let adjusted: Awaited<ReturnType<typeof ports.context.afterUsage>>
          let announced = false
          try {
            let announce!: (event: RunEvent) => void
            let rejectAnnouncement!: (error: unknown) => void
            const start = new Promise<RunEvent>((resolve, reject) => {
              announce = resolve
              rejectAnnouncement = reject
            })
            let release!: (proceed: boolean) => void
            const resume = new Promise<boolean>(resolve => { release = resolve })
            const work = ports.context.afterUsage(state.context, state.usage, controller.signal, async () => {
              try {
                const event = await commit({}, 'compaction', { phase: 'started', reason: 'usage_threshold' })
                announce(event!)
              } catch (error) {
                rejectAnnouncement(error)
                throw error
              }
              if (!await resume)
                throw new AgentRunError('cancelled', '当前任务已取消')
            })
            const first = await Promise.race([
              start.then(event => ({ event })),
              work.then(result => ({ result })),
            ])
            if ('event' in first) {
              announced = true
              let proceed = false
              try {
                yield first.event
                proceed = true
              } finally {
                release(proceed)
              }
              adjusted = await work
            } else {
              adjusted = first.result
            }
            const after = contextSummaryMetrics(ports.observationSnapshot?.(adjusted.context))
            observePhase(identity, 'Context compaction', compactionStartedAt, state.round,
              adjusted.applied ? 'success' : 'skipped', {
                phase: 'completed', applied: adjusted.applied, reason: adjusted.reason ?? 'not_applied',
                before_messages: before.message_count, after_messages: after.message_count,
                before_summary_count: before.summary_count, after_summary_count: after.summary_count,
                before_summary_chars: before.summary_chars, after_summary_chars: after.summary_chars,
              })
            if (!adjusted.applied) {
              const failed = adjusted.reason === 'failed'
              logRun(identity, failed ? 'error' : 'info', failed ? 'agent.context.compaction_failed' : 'agent.context.compaction_skipped', state.round,
                { reason: failed ? 'summary_failed' : adjusted.reason ?? 'not_applied' })
            }
          }
          catch (error) {
            observePhase(identity, 'Context compaction', compactionStartedAt, state.round,
              error instanceof AgentRunError && error.code === 'cancelled' ? 'cancelled' : 'error', {
                phase: 'failed', reason: 'error', before_messages: before.message_count,
                before_summary_count: before.summary_count, before_summary_chars: before.summary_chars,
              })
            throw error
          }
          if (adjusted.applied || announced)
            yield (await commit({ context: adjusted.context }, 'compaction', {
              phase: 'completed', reason: adjusted.applied ? 'usage' : adjusted.reason ?? 'not_applied', applied: adjusted.applied,
            }))!
          else if (adjusted.context !== state.context)
            await commit({ context: adjusted.context })
        }
      }
      return state
    }
    catch (error) {
      if (!state || persistenceUncertain || finalized) {
        if (error instanceof AgentRunError)
          throw error
        throw new AgentRunError('invalid_state', ports.sanitizeText(ports.presentError(error).text))
      }
      if (error instanceof AgentRunError && ['conflict', 'not_found', 'lease_lost', 'persistence_unknown'].includes(error.code))
        throw error
      if (error instanceof ToolResultCheckpointUnavailable) {
        await commit({ unpersistedToolResult: error.observed, mutated: state.mutated || error.observed.mutated })
        yield await finish('unknown', 'tool_receipt_not_persisted', '工具执行回执未能安全保存，执行结果需要重新核对，请勿重复操作。')
        return state
      }
      if (state.phase === 'provider' && error instanceof ProviderError && error !== lastProviderFailure)
        reportProviderFailure(error, error.code === 'context_overflow')
      const rejected = await rejectPendingOverflow()
      if (rejected)
        yield rejected
      if (controller.signal.aborted || (error instanceof AgentRunError && error.code === 'cancelled')) {
        for await (const event of closeInteractions('cancelled'))
          yield event!
        for await (const event of closeTools('cancelled', 'deferred'))
          yield event!
        yield await finish('cancelled', null, '')
      }
      else {
        try { ports.diagnose('run_failed', { identity, phase: state.phase, error }) }
        catch { /* 诊断失败不得掩盖运行终态。 */ }
        const presented = ports.presentError(error)
        yield await finish('failed', presented.code, ports.sanitizeText(presented.text))
      }
      return state
    }
    finally {
      controller.abort()
      active.delete(identityKey)
      activeSessions.delete(sessionKey)
      try {
        unsubscribe?.()
      }
      catch {
        ports.diagnose('unsubscribe_failed')
      }
      if (ports.context.release) {
        try {
          await ports.context.release(identity)
        }
        catch {
          ports.diagnose('context_release_failed')
        }
      }
      if (lease) {
        try {
          await ports.leases.release(identity, lease)
        }
        catch {
          ports.diagnose('release_failed')
        }
      }
    }
  }
  return {
    start: (identity, options) => drive(identity, true, undefined, options?.scheduled ?? false, options?.anchorMessageId ?? null, options?.goalMode ?? false, options?.replyChoice ?? 'disabled'),
    resume: (identity, resolution) => drive(identity, false, resolution),
    cancel: (identity: RunIdentity) => requestRunCancellation(ports, active, read, identity),
    replay,
  }
}

export const numeric = ['input', 'context_input', 'output', 'cache_read', 'cache_write', 'output_token_budget'] as const

export const tags = ['run_id', 'round_id'] as const

export const reasons = {
  finish_reason: new Set(['stop', 'end_turn', 'tool_calls', 'tool_use', 'length', 'max_tokens', 'incomplete', 'failed', 'content_filter']),
  incomplete_reason: new Set(['max_output_tokens', 'content_filter', 'unknown']),
}

/** 诊断只保留用量、固定原因和不含内容的关联标识，不复制prompt/response或任意额外字段。 */
export function projectProviderDiagnostic(input: unknown): Readonly<Record<string, string | number | null>> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new AgentRunError('invalid_state', '模型轮次诊断无效')
  const data = input as Record<string, unknown>
  const result: Record<string, string | number | null> = {}
  for (const name of numeric) {
    const value = data[name]
    if (value === undefined)
      continue
    if (value === null)
      result[name] = null
    else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      result[name] = value
    else
      throw new AgentRunError('invalid_state', '模型轮次用量无效')
  }
  for (const name of tags) {
    const value = data[name]
    if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value))
      result[name] = value
  }
  for (const name of ['finish_reason', 'incomplete_reason'] as const) {
    const value = data[name]
    if (value === null)
      result[name] = null
    else if (typeof value === 'string')
      result[name] = reasons[name].has(value) ? value : 'unknown'
  }
  return Object.freeze(result)
}

export const finalToolStatuses = new Set(['success', 'error', 'skipped', 'cancelled', 'stopped', 'deferred', 'unknown'])

/** 对展示事件做有身份的upsert：更新状态不能改变原位置、首次时间或anchor。 */
function updateToolTiming(previous: DisplayItem | undefined, status: string | undefined, now: string): Partial<DisplayItem> {
  if (status === 'running') return {
    toolStartedAt: previous?.toolStatus === 'running' ? previous.toolStartedAt ?? previous.updatedAt : now,
  }
  if (previous?.toolStatus !== 'running' || status === undefined) return {}
  const elapsed = Date.parse(now) - Date.parse(previous.toolStartedAt ?? previous.updatedAt)
  return {
    toolStartedAt: null,
    ...(Number.isFinite(elapsed) ? { toolDurationMs: (previous.toolDurationMs ?? 0) + Math.max(0, elapsed) } : {}),
  }
}

export function updateDisplayItem(items: readonly DisplayItem[], incoming: Pick<DisplayItem, 'kind' | 'runId' | 'roundId'> & Partial<DisplayItem>, scope: {
  readonly anchorMessageId: string | null
  readonly now: string
}): readonly DisplayItem[] {
  const index = items.findIndex((item) => incoming.eventId ? item.eventId === incoming.eventId : incoming.kind === 'tool' && item.kind === 'tool' && item.runId === incoming.runId && item.roundId === incoming.roundId && item.toolCallId === incoming.toolCallId)
  if (index >= 0) {
    const old = items[index]!
    if (finalToolStatuses.has(old.toolStatus ?? '') && ['queued', 'running', 'waiting'].includes(incoming.toolStatus ?? ''))
      return items
    const next = [...items]
    next[index] = {
      ...old, ...incoming, ...(old.kind === 'tool' ? updateToolTiming(old, incoming.toolStatus, scope.now) : {}),
      eventId: old.eventId, sequence: old.sequence, anchorMessageId: old.anchorMessageId,
      timelineOrder: old.timelineOrder, createdAt: old.createdAt, updatedAt: scope.now,
    }
    return next
  }
  const sequence = items.length + 1
  const timelineOrder = scope.anchorMessageId === null ? null : (BigInt(scope.anchorMessageId) * 1000000n + BigInt(sequence)).toString()
  return [...items, {
    ...incoming,
    ...(incoming.kind === 'tool' ? updateToolTiming(undefined, incoming.toolStatus, scope.now) : {}),
    eventId: incoming.eventId ?? `${incoming.runId}:display:${sequence}`,
    sequence, anchorMessageId: scope.anchorMessageId, timelineOrder,
    createdAt: scope.now, updatedAt: scope.now,
  }]
}

/** 封存只关闭仍打开的气泡，不补造身份、时间和顺序，也不改调用方原数组。 */
export function sealDisplayTimeline(items: readonly DisplayItem[], now: string,
  incomplete: boolean | ((item: DisplayItem) => boolean) = false): readonly DisplayItem[] {
  const isOpen = (item: DisplayItem) => item.kind === 'tool' && ['queued', 'running', 'waiting'].includes(item.toolStatus ?? '')
  const unresolvedIndex = incomplete === true ? items.findLastIndex(item => isOpen(item) && item.toolStatus !== 'queued') : -1
  return items.map((item, index) => {
    if (!isOpen(item)) return item
    const unknown = typeof incomplete === 'function' ? incomplete(item) : index === unresolvedIndex
    const toolStatus = unknown ? 'unknown' : 'stopped'
    return { ...item, ...updateToolTiming(item, toolStatus, now), toolStatus, updatedAt: now }
  })
}

export function reference(value: string): boolean { return /^[A-Za-z0-9_.:-]{1,256}$/.test(value) }

export function snapshotCursor(value: ProviderCursor): ProviderCursor {
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || (value.reference !== null && (typeof value.reference !== 'string' || !reference(value.reference))))
    throw new AgentRunError('invalid_state', '模型流游标无效')
  return Object.freeze({ sequence: value.sequence, reference: value.reference })
}

export function sanitizerCheckpoint(sanitizer: StreamSanitizer): SanitizerCheckpoint {
  const value = sanitizer.checkpoint?.() ?? { kind: 'unavailable' as const }
  if (value.kind === 'reference' && !reference(value.reference))
    throw new AgentRunError('invalid_state', '清洗器状态引用无效')
  if (!['clean', 'unavailable', 'reference'].includes(value.kind))
    throw new AgentRunError('invalid_state', '清洗器恢复状态无效')
  return value.kind === 'reference' ? Object.freeze({ kind: 'reference', reference: value.reference }) : Object.freeze({ kind: value.kind })
}

export function sameRecoveryBoundary(left: ProviderRecoveryBoundary, right: ProviderRecoveryBoundary): boolean {
  return left.identity.ownerId === right.identity.ownerId && left.identity.sessionId === right.identity.sessionId && left.identity.runId === right.identity.runId
    && left.round === right.round && left.runSequence === right.runSequence && left.roundText === right.roundText
    && left.cursor?.sequence === right.cursor?.sequence && left.cursor?.reference === right.cursor?.reference
    && left.sanitizer.kind === right.sanitizer.kind
    && (left.sanitizer.kind !== 'reference' || right.sanitizer.kind === 'reference' && left.sanitizer.reference === right.sanitizer.reference)
}

function redactToolCredentials(text: string): string {
  return text
    .replace(/\b(?:postgres(?:ql)?|redis|rediss|mysql|mongodb):\/\/[^\s'"]+/gi, '‹连接串已隐藏›')
    .replace(/\b(?:sk-[A-Za-z0-9]{16,}|(?:api[_-]?key|token|secret|bearer)["'=:\s]+[A-Za-z0-9._-]{12,})/gi, '‹密钥已隐藏›')
}

/** 对应Python公共错误出口的处理顺序；不用于正常业务正文。 */
export function redactToolError(text: string, keepPaths = false): string {
  const clean = redactToolCredentials(text)
  const message = keepPaths ? clean : clean
    .replace(/(?:\.{0,2}\/)?(?:uploads|\.agent|\.thumbs|\.chat_staging)\/[^\s'"]*|\/(?:home|opt|Users|var|etc|root|tmp|private)\/[^\s'"]*/g, '‹路径已隐藏›')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '‹id已隐藏›')
  return message.replace(/\n?\s*File "[^"]+", line \d+[^\n]*(?:\n\s+[^\n]+)?/g, '')
    .trim()
}

/** 工具参数只投影到 owner 可读的展示时间线，清理凭据和过大的输入。 */
export function projectPersistentToolInput(value: unknown, _toolName?: string): PortableValue {
  function redact(input: Json): Json {
    if (typeof input === 'string') return redactToolCredentials(input)
    if (Array.isArray(input)) return input.map(child => redact(child))
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, child]) => [
      key, /(?:password|passwd|secret|token|credential|api[_-]?key|authorization|cookie|private[_-]?key)/i.test(key)
        ? '[已隐藏]' : redact(child),
    ]))
    return input
  }
  const input = redact(redactToolRequestHeaders(stripHistoryMedia(portableSnapshot(value) as Json)))
  return JSON.stringify(input).length <= 16_000 ? input : '[输入过长，已隐藏]'
}

/**
 * 持久化/展示通用规则：媒体留占位、error递归脱敏；正常read_file正文不做秘密字段猜测。
 * 业务凭据必须由可信呈现Adapter与credential交互边界处理，不能把任意正文当错误删改。
 */
export function projectPersistentToolResult(value: unknown, showPaths = false): PortableValue {
  function visit(input: PortableValue): PortableValue {
    const pruned = stripHistoryMedia(input as unknown as Json) as PortableValue
    if (typeof pruned === 'string') {
      const trimmed = pruned.trimStart()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        let parsed: unknown
        try {
          parsed = JSON.parse(pruned)
        }
        catch {
          return pruned
        }
        const snapshot = portableSnapshot(parsed)
        const projected = visit(snapshot)
        return JSON.stringify(projected) === JSON.stringify(snapshot) ? pruned : JSON.stringify(projected)
      }
      return pruned
    }
    if (Array.isArray(pruned))
      return pruned.map(visit)
    if (pruned && typeof pruned === 'object') {
      return Object.fromEntries(Object.entries(pruned).map(([name, child]) => [name,
        name === 'error' && typeof child === 'string' ? redactToolError(child, showPaths) : visit(child),
      ]))
    }
    return pruned
  }
  return portableSnapshot(visit(portableSnapshot(value)))
}



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
