import { ProviderError, providerFailureFields } from '../providers/errors.js'
import { mergeUsage } from '../context/budget.js'
import type { DisplayItem,DispatchOutcome,InteractionResolution,Lease,ProviderCursor,ReplyChoice,ReplyGateCall,RunCheckpoint,RunEvent,AgentRunner,RunIdentity,SanitizerCheckpoint,ToolCall,ToolPlan,ToolResult } from '../models.js'
import { AgentRunError,isEarlyExit,RunStoreRejected,ToolResultCheckpointUnavailable } from '../models.js'
import { cacheResultForRun,encodeResultForRun,hydrateResultForRun,normalizePersistentArtifact } from '../context/history/attachment-refs.js'
import { portableSnapshot,snapshotInteraction,snapshotToolCall,snapshotToolResult } from '../context/history/canonical-history.js'
import { activateNextInteractionForRun,closeInteractionsForRun,completeResolutionClosureForRun,resumeWaitingRun } from '../interactions/coordinator.js'
import type { AgentRunnerPorts,RunCoordination } from '../ports.js'
import { describeShellActivity } from '../shell-activity.js'
import { recordAgentObservation } from '../observation.js'
import { cancellable,checkCancellationForRun,requestRunCancellation,stoppedResultForRun } from '../run/cancellation.js'
import { closeToolsForRun,finishForRun } from '../run/finalization.js'
import { assertRunCheckpoint,assertRunIdentity,assertRunTransition,decideReply,decideReplyGate,emptyRunUsage,goalCompleted,initialReplyState,readRunCheckpoint,runIdentityKey,stripGoalMarker,terminalRunStates,toolReplyProgress } from '../run/lifecycle.js'
import { parallelBatchForRun,providerStreamLifetime,publishRunEvent,replayRunEvents } from '../run/streaming.js'
import { rejectAdapterCall } from '../tools/meta/call-adapter.js'
import { contextSummaryMetrics, createRunnerObservation, skillInjectionMetadata } from './observation.js'
import { projectProviderDiagnostic } from './provider-diagnostics.js'
import { sealDisplayTimeline, updateDisplayItem } from './display-timeline.js'
import { sameRecoveryBoundary, sanitizerCheckpoint, snapshotCursor } from './provider-recovery.js'
import { projectPersistentToolInput, projectPersistentToolResult } from './tool-projection.js'
import { bindToolExecution } from './tool-execution.js'
import { partitionToolPlan } from './tool-plan.js'

/** 模型增量的分块提交阈值：达到任一条件即落一次事件与 checkpoint。 */
const TOKEN_FLUSH_CHARS = 256
const TOKEN_FLUSH_MS = 200



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
  const observation = createRunnerObservation(ports)
  const { observedAt, observePhase, logRun, recordToolSchemaFailure, observeEvent } = observation
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
      const [patch, type, payload = {}, history = null, interactionReceipt = null, subagentFinalIds, inboxMessageIds] = args
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
        const cards = artifact && typeof artifact === 'object' && !Array.isArray(artifact) && 'kind' in artifact
          ? artifact.kind === 'object_card' ? [artifact]
            : artifact.kind === 'object_cards' && 'cards' in artifact && Array.isArray(artifact.cards) ? artifact.cards : null
          : null
        const text = cards?.flatMap(card => {
          if (!card || typeof card !== 'object' || Array.isArray(card) || !('name' in card)
            || typeof card.name !== 'string' || !('link' in card) || typeof card.link !== 'string') return []
          const label = Array.from(String(card.name)).map(ch => /[\p{P}\p{S}\s]/u.test(ch) ? `&#${ch.codePointAt(0)};` : ch).join('')
          return [`[${label || '文件库卡片'}](${card.link})`]
        }).join('\n\n') ?? ''
        displayTimeline = updateDisplayItem(displayTimeline, { kind: 'assistant', runId: identity.runId, roundId, text,
          ...(cards ? {} : buttons ? { linkButtons: artifact } : { files: [artifact] }) }, { anchorMessageId: state.anchorMessageId, now })
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
        const subagentTerminalDelivery = terminalRunStates.has(next.status) ? ports.subagentTerminalDelivery?.(next) : undefined
        await ports.store.commit({ identity, expectedVersion: state.version, lease, checkpoint: next, events: event ? [event] : [], history, interactionReceipt, ...(subagentFinalIds?.length ? { subagentFinalIds } : {}),
          ...(inboxMessageIds?.length ? { inboxMessageIds } : {}),
          ...(subagentTerminalDelivery ? { subagentTerminalDelivery } : {}),
          ...(patch.agentInboxWaiting !== undefined ? { agentInboxWaiting: patch.agentInboxWaiting } : {}),
          ...(patch.subagentWaitChildId !== undefined ? { subagentWaitChildId: patch.subagentWaitChildId } : {}) })
      }
      catch (error) {
        try { ports.diagnose('run_failed', { identity, phase: next.phase, error }) }
        catch { /* 持久化故障仍按原错误退出。 */ }
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
    const executeTool = bindToolExecution(ports, identity, controller.signal, {
      readState: () => state!, dispatchKey, dispatchedCalls, uncertainExecutions, observation,
    })
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
      const isDisplayOnlyArtifact = artifact !== undefined && artifact !== null && typeof artifact === 'object' && !Array.isArray(artifact) && 'kind' in artifact && (artifact.kind === 'link_buttons' || artifact.kind === 'object_card' || artifact.kind === 'object_cards')
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
      const startedSubagent = result.successful && call.name === 'agent_message' && call.input
        && typeof call.input === 'object' && 'action' in call.input
        && (call.input.action === 'spawn' || Boolean(result.value && typeof result.value === 'object'
          && 'started' in result.value && result.value.started === true))
      const childId = result.successful && call.name === 'agent_wait' && result.value
        && typeof result.value === 'object' && 'childId' in result.value && typeof result.value.childId === 'string'
        && 'status' in result.value && ['completed', 'partial', 'failed', 'cancelled'].includes(String(result.value.status))
        && !('alreadyDelivered' in result.value) ? result.value.childId : undefined
      const crossRunDelivery = childId && result.value && typeof result.value === 'object'
        && 'deliveryRunId' in result.value && typeof result.value.deliveryRunId === 'string' ? result.value.deliveryRunId : undefined
      const consumedSubagent = crossRunDelivery ? `run:${crossRunDelivery}` : state.acceptsSubagentFinals ? childId : undefined
      const presented = projectPersistentToolResult(await ports.presentToolResult(result.value, { identity, round: state.round, call }), true)
      return (await commit({
        context,
        ...(startedSubagent && ports.store.readSubagentFinals ? { acceptsSubagentFinals: true } : {}),
        queuedInteractions: state.queuedInteractions.filter((item) => item.id !== consumeInteractionId),
        inflightCall: null,
        inflightCalls: state.inflightCalls.filter((item) => item.id !== call.id),
        callIndex: state.callIndex + (advance ? 1 : 0), replayCall: null, replayResultReady: false,
        resolution: null,
        completedToolCount: state.completedToolCount + (result.executed === false || resultStatus === 'cancelled' || resultStatus === 'deferred' ? 0 : 1),
        mutated: state.mutated || result.mutated,
        files: artifact === undefined || isDisplayOnlyArtifact ? state.files : [...state.files, artifact],
        emptyRetries: result.successful ? 0 : state.emptyRetries,
        replyState: toolReplyProgress(state.replyState, result.successful),
      }, 'tool_done', { toolCallId: call.id, name: call.name, status: resultStatus, result: presented, ...(artifact === undefined ? {} : { artifact }) }, null, null, consumedSubagent ? [consumedSubagent] : undefined))!
    }
    async function agentInboxReady() {
      return Boolean((await ports.store.readAgentInbox?.(identity))?.length
        || (await ports.store.readSubagentFinals?.(identity))?.length)
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
          const input = call.input
          const childId = state.acceptsSubagentFinals && call.name === 'agent_wait' && !call.parseError
            && input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 1
            && 'childId' in input && typeof input.childId === 'string' && /^[a-f0-9]{8}$/.test(input.childId)
            ? input.childId : null
          if (childId && !serialWaiting && !controller.signal.aborted && !state.inflightCall
            && await ports.store.isSubagentPending?.(identity, childId)) {
            await checkCancellation()
            await commit({ status: 'waiting', subagentWaitChildId: childId })
            return
          }
          if ((state.acceptsSubagentFinals || ports.acceptsAgentInbox) && call.name === 'agent_wait' && !call.parseError
            && input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 0
            && !serialWaiting && !controller.signal.aborted && !state.inflightCall
            && ports.store.readAgentInbox && !await agentInboxReady()) {
            await checkCancellation()
            await commit({ status: 'waiting', agentInboxWaiting: true })
            return
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
          maxRounds: ports.maxRounds ?? (scheduled ? 100 : null), goalMode, replyChoice: initialReplyChoice, roundRequiresTools: false, completedToolCount: 0, remoteStatusUnknown: false, errorCode: null, earlyExitReason: null,
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
        if (state.status === 'waiting' && state.agentInboxWaiting) {
          await checkCancellation()
          if (resolution || !ports.store.readAgentInbox)
            throw new AgentRunError('conflict', '收件箱等待状态不匹配')
          if (state.phase === 'decision') {
            // 子任务已结束时，即使回执已被同会话后续运行读走，也要继续收尾。
            if (await ports.store.hasPendingSubagents?.(identity)) return state
          } else if (!await agentInboxReady()) return state
          yield (await commit({ status: 'running', agentInboxWaiting: false }, 'run_resumed'))!
        } else if (state.status === 'waiting' && state.subagentWaitChildId) {
          await checkCancellation()
          if (resolution || !ports.store.isSubagentPending)
            throw new AgentRunError('conflict', '子任务等待状态不匹配')
          if (await ports.store.isSubagentPending(identity, state.subagentWaitChildId)) return state
          yield (await commit({ status: 'running', subagentWaitChildId: null }, 'run_resumed'))!
        } else {
          if (state.status === 'waiting') { const stopped = yield* resumeWaitingRun(scope, resolution); if (stopped) return state }
          yield (await commit({}, 'run_resumed'))!
        }
      }
      let queuedInbox: Awaited<ReturnType<NonNullable<typeof ports.store.readAgentInbox>>> | undefined
      let queuedFinals: Awaited<ReturnType<NonNullable<typeof ports.store.readSubagentFinals>>> | undefined
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
          const capabilities = (context as { capabilities?: { toolNames?: readonly string[] } | null } | null)?.capabilities
          await commit({ context, status: 'running', phase: 'idle',
            ...(ports.store.readSubagentFinals && capabilities?.toolNames?.some(name => name === 'agent_inbox' || name === 'agent_wait') ? { acceptsSubagentFinals: true } : {}),
          })
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
          if (state.subagentWaitChildId || state.agentInboxWaiting) return state
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
          if ((state.acceptsSubagentFinals || ports.acceptsAgentInbox) && (state.maxRounds === null || state.round < state.maxRounds)) {
            if (state.acceptsSubagentFinals && await ports.store.hasPendingSubagents?.(identity)) {
              await checkCancellation()
              yield (await commit({ status: 'waiting', agentInboxWaiting: true }, 'run_waiting'))!
              return state
            }
            if (state.acceptsSubagentFinals) queuedFinals = await ports.store.readSubagentFinals?.(identity)
            queuedInbox = await ports.store.readAgentInbox?.(identity)
            if (queuedFinals?.length || queuedInbox?.length) {
              await commit({ phase: 'idle' })
              continue
            }
          }
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
            yield await finish('failed', 'round_limit', '运行已达到执行轮次上限。')
            return state
          }
          // 只有确实要发下一次模型请求时才按上一轮实际用量压缩。
          if (state.round > 0 && state.usageAppliedRound === state.round
            && !state.overflowRecoveryPending && state.usage.contextInput !== null) {
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
              if (!adjusted.applied && adjusted.reason !== 'below_threshold') {
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
          let nextContext: C = state.context
          const finals = queuedFinals ?? (state.acceptsSubagentFinals ? await ports.store.readSubagentFinals?.(identity) : undefined) ?? []
          queuedFinals = undefined
          const messages = queuedInbox ?? ((state.acceptsSubagentFinals || ports.acceptsAgentInbox ? await ports.store.readAgentInbox?.(identity) : undefined) ?? [])
          queuedInbox = undefined
          if ((finals.length || messages.length) && !ports.context.appendReminder)
            throw new AgentRunError('invalid_state', '运行不支持追加消息')
          for (const { message } of messages)
            nextContext = await ports.context.appendReminder!(nextContext, `【Agent 消息】\n${message}`)
          for (const { deliveryRunId: _deliveryRunId, ...result } of finals)
            nextContext = await ports.context.appendReminder!(nextContext, `【子任务结果】\n${JSON.stringify(result)}`)
          let displayTimeline = state.displayTimeline
          for (const { deliveryRunId, ...result } of finals) {
            displayTimeline = updateDisplayItem(displayTimeline, {
              kind: 'tool', runId: identity.runId, roundId: `${identity.runId}:${state.round + 1}`,
              toolCallId: `subagent-result:${deliveryRunId ?? result.childId}`, toolName: 'subagent_result',
              toolStatus: result.status === 'failed' ? 'error' : result.status === 'cancelled' ? 'cancelled' : 'success',
              toolResult: projectPersistentToolResult(result, true),
            }, { anchorMessageId: state.anchorMessageId, now: ports.clock.now() })
          }
          yield (await commit({ context: nextContext, displayTimeline, phase: 'provider', round: state.round + 1, text: '', usage: emptyRunUsage, providerCursor: null, sanitizerCheckpoint: { kind: 'clean' } }, 'round_start', {
            ...(finals.length ? { subagentDisplays: displayTimeline.slice(state.displayTimeline.length) } : {}),
          }, null, null, finals.map(result => result.deliveryRunId ? `run:${result.deliveryRunId}` : result.childId), messages.map(item => item.id)))!
          providerRecovery = false
        }
        const providerLifetime = providerStreamLifetime(controller.signal)
        const request = { identity, round: state.round, context: state.context, signal: providerLifetime.signal, replyChoice: state.replyChoice }
        const sanitizer = ports.createStreamSanitizer({ identity, round: state.round })
        let sanitizerTouched = false
        let sanitizerFlushed = false
        const captureSanitizer = (): SanitizerCheckpoint => sanitizerFlushed || !sanitizerTouched ? { kind: 'clean' } : sanitizerCheckpoint(sanitizer)
        // 模型增量按块提交：逐 token 落库会把累积全文与整份 checkpoint 反复重写，
        // 单轮产生 O(n²) 的事件存储和百 MB 级写入。这里按字节与时间双阈值合并，
        // 游标与正文同步推进；未提交的增量在崩溃后由 Provider 按游标重放，不丢内容。
        let pendingToken = ''
        let pendingTokenSince = observedAt()
        // 分块提交下 checkpoint 里的游标会滞后，连续性判定改用本轮已见游标。
        let streamCursorSequence = state.providerCursor?.sequence ?? 0
        let streamCursorReference = state.providerCursor?.reference ?? null
        const streamPatchAt = (at: ProviderCursor | null) => ({ providerCursor: at ?? state!.providerCursor, sanitizerCheckpoint: captureSanitizer() })
        async function* flushPendingToken(cursor: ProviderCursor | null) {
          if (!pendingToken) return
          const chunk = pendingToken
          pendingToken = ''
          pendingTokenSince = observedAt()
          const patch = { ...streamPatchAt(cursor), text: state!.text + chunk }
          if (state!.goalMode || state!.replyState.guardPending || state!.replyChoice === 'pending')
            await commit(patch)
          else
            yield (await commit(patch, 'token', { text: chunk }))!
        }
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
        let pendingRead: ReturnType<typeof iterator.next> | undefined
        let pendingTokenCursor: ProviderCursor | null = null
        let complete = false
        let overflow = false
        try {
          while (true) {
            pendingRead ??= cancellable(iterator.next(), controller.signal)
            let timer: ReturnType<typeof setTimeout> | undefined
            const next = await (pendingToken ? Promise.race([
              pendingRead,
              new Promise<null>(resolve => {
                timer = setTimeout(() => resolve(null), Math.max(0, TOKEN_FLUSH_MS - (observedAt() - pendingTokenSince)))
              }),
            ]) : pendingRead).finally(() => clearTimeout(timer))
            if (next === null) {
              yield* flushPendingToken(pendingTokenCursor)
              continue
            }
            pendingRead = undefined
            if (next.done) {
              yield* flushPendingToken(pendingTokenCursor)
              break
            }
            const item = next.value
            const cursor = item.cursor ? snapshotCursor(item.cursor) : null
            if (cursor && streamCursorSequence > 0) {
              if (cursor.sequence < streamCursorSequence || cursor.sequence === streamCursorSequence && cursor.reference === streamCursorReference)
                continue
            }
            if ((cursor && cursor.sequence !== streamCursorSequence + 1) || (recovering && !cursor)) {
              const rejected = await rejectPendingOverflow()
              if (rejected)
                yield rejected
              yield await finish('unknown', 'provider_resume_gap', '模型续接事件不完整，未继续执行工具，请重新查询运行状态。')
              return state
            }
            if (cursor) { streamCursorSequence = cursor.sequence; streamCursorReference = cursor.reference }
            const streamPatch = (at: ProviderCursor | null = cursor) => streamPatchAt(at)
            if (item.type === 'token') {
              sanitizerTouched = true
              const text = sanitizer.feed(item.text)
              pendingTokenCursor = cursor
              if (text) {
                pendingToken += text
                const now = observedAt()
                if (pendingToken.length >= TOKEN_FLUSH_CHARS || now - pendingTokenSince >= TOKEN_FLUSH_MS)
                  yield* flushPendingToken(cursor)
              }
              else if (!pendingToken)
                await commit(streamPatch(cursor))
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
              // 用量事件会推进已提交游标；先提交待写增量，避免游标越过未落库的正文。
              yield* flushPendingToken(cursor)
              await commit({ ...streamPatch(), usage: item.usage })
            }
            else if (item.type === 'diagnostic') {
              const diagnostic = projectProviderDiagnostic(item.data)
              yield* flushPendingToken(cursor)
              yield (await commit({ ...streamPatch(), providerRounds: [...state.providerRounds, diagnostic] }, 'provider_diagnostic', diagnostic))!
            }
            else if (item.type === 'retry') {
              if (!Number.isSafeInteger(item.attempt) || item.attempt < 1 || !Number.isSafeInteger(item.maxRetries) || item.maxRetries < item.attempt || !Number.isSafeInteger(item.nextRetryMs) || item.nextRetryMs < 0)
                throw new AgentRunError('invalid_state', '模型重试事件无效')
              const errorCode = ['rate_limited', 'timeout', 'transport', 'upstream_busy'].includes(item.errorCode) ? item.errorCode : 'unknown'
              logRun(identity, 'info', 'agent.provider.retry', state.round, { attempt: item.attempt, maxRetries: item.maxRetries, nextRetryMs: item.nextRetryMs, errorCode })
              yield* flushPendingToken(cursor)
              yield (await commit(streamPatch(), 'retry', { attempt: item.attempt, maxRetries: item.maxRetries, nextRetryMs: item.nextRetryMs, errorCode }))!
            }
            else if (item.type === 'error') {
              reportProviderFailure(item.error, item.contextOverflow === true)
              // 出错与上下文溢出前先提交待写增量，否则已收到的正文尾部会随运行失败一起丢失。
              yield* flushPendingToken(cursor)
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
              // 整轮游标由工具计划提交确认；提前提交正文时保留可恢复的文本游标。
              yield* flushPendingToken(pendingTokenCursor)
              const tail = sanitizer.flush()
              sanitizerFlushed = true
              const text = ports.sanitizeText(item.text).trim()
              const visibleText = !state.goalMode && !state.replyState.guardPending && state.replyChoice === 'disabled'
              if (tail) {
                if (state.goalMode || state.replyState.guardPending || state.replyChoice === 'pending')
                  await commit({ text: state.text + tail, sanitizerCheckpoint: captureSanitizer() })
                else
                  yield (await commit({ text: state.text + tail, sanitizerCheckpoint: captureSanitizer() }, 'token', { text: tail }))!
              }
              if (visibleText && text && item.calls.length)
                yield (await commit({}, 'text_end', { text }))!
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
                    value: { ...(ports.tools.unavailableTool?.(call.name) ?? { error: '工具不存在或未开放' }), next_action: '请从当前工具目录选择已开放的工具，勿重复调用此工具。' },
                  } })
                  return call
                }
                if (call.name !== 'call_tool' || !ports.tools.resolveCall) return call
                const target = await ports.tools.resolveCall(call, identity, controller.signal)
                if ('call' in target) return snapshotToolCall(target.call)
                adapterResults.push({ callId: call.id, result: rejectAdapterCall(target.error, target.error_code) })
                return call
              })))
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
        catch (error) {
          if (controller.signal.aborted || error instanceof AgentRunError && error.code === 'cancelled')
            yield* flushPendingToken(pendingTokenCursor)
          throw error
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
