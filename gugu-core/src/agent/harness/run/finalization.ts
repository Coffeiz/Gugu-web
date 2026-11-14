
import { mergeUsage } from '../context/budget.js'
import type { RunEvent } from '../contracts.js'
import { HarnessError } from '../contracts.js'
import type { RunCoordination } from '../ports.js'

export async function finishForRun<C>(scope: RunCoordination<C>, status: 'completed' | 'cancelled' | 'failed' | 'unknown', code: string | null, text: string, silent = false): Promise<RunEvent> {
  if (!scope.state || scope.finalized)
    throw new HarnessError('invalid_state', '运行已终结')
  const history = scope.state.context !== null && (status === 'completed' || (status === 'cancelled' && (scope.state.text || scope.state.roundTexts.length || scope.state.completedToolCount || scope.state.displayTimeline.some((item) => item.kind === 'tool' && item.toolStatus === 'cancelled'))))
    ? { outcome: (silent ? 'silent' : status === 'cancelled' ? 'interruption' : 'success') as 'success' | 'interruption' | 'silent', context: scope.state.context, text: status === 'cancelled' ? scope.state.text : text }
    : null
  const remoteStatusUnknown = status === 'unknown' || scope.state.remoteStatusUnknown || scope.uncertainExecutions.size > 0 || (status === 'cancelled' && scope.state.phase === 'provider')
  const totalUsage = scope.state.phase === 'provider' && scope.state.round > 0 && scope.state.usageAppliedRound !== scope.state.round ? mergeUsage(scope.state.totalUsage, scope.state.usage) : scope.state.totalUsage
  const event = await scope.commit({ status, phase: 'idle', errorCode: code, remoteStatusUnknown, text: status === 'cancelled' ? scope.state.text : text, pending: null, queuedInteractions: [], replayCall: null, replayResultReady: false, resolution: null, resolutionClosure: null, totalUsage, usageAppliedRound: scope.state.round, replyChoice: scope.state.replyChoice === 'pending' && text ? 'reply' : scope.state.replyChoice }, 'final', { status, text: status === 'cancelled' ? '' : text, errorCode: code, remoteStatusUnknown, usage: totalUsage, mutated: scope.state.mutated, files: scope.state.files, providerRounds: scope.state.providerRounds }, history)
  scope.finalized = true
  if (status === 'completed' && !silent && scope.state.context !== null && scope.ports.context.afterFinal) {
    try {
      await scope.ports.context.afterFinal(scope.identity, scope.state.context, { status: 'completed', text, roundTexts: scope.state.roundTexts, usage: scope.state.totalUsage, hadTools: scope.state.replyState.anyToolCalled, displayTimeline: scope.state.displayTimeline })
    }
    catch {
      // 持久化已经成功，Job发布异常不能改写终态或重放本轮业务。
      scope.ports.diagnose('finalization_hook_failed')
    }
  }
  return event!
}

export async function* closeToolsForRun<C>(scope: RunCoordination<C>, currentStatus: 'cancelled' | 'error', remainingStatus: 'cancelled' | 'deferred'): AsyncGenerator<RunEvent> {
  if (!scope.state || scope.state.context === null || scope.state.phase !== 'tools')
    return
  let context: C = scope.state.context
  for (let index = scope.state.callIndex;index < scope.state.calls.length;index++) {
    const call = scope.state.calls[index]!
    const status = index === scope.state.callIndex ? currentStatus : remainingStatus
    context = await scope.ports.context.afterTool(context, call, { kind: 'completed', value: { status }, successful: false, mutated: false, executed: scope.dispatchedCalls.has(scope.dispatchKey(call)) }, scope.state.round)
    yield (await scope.commit({ context, inflightCall: null }, 'tool_done', { toolCallId: call.id, name: call.name, status }))!
  }
  await scope.commit({ calls: [], callIndex: 0, inflightCall: null, inflightCalls: [], pending: null, queuedInteractions: [], replayCall: null, resolution: null })
}
