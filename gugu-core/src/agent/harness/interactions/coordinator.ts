import { snapshotInteraction } from '../history/canonical-history.js'

import type { InteractionResolution,ResolutionClosure,RunEvent } from '../contracts.js'
import { HarnessError } from '../contracts.js'
import { portableSnapshot } from '../history/canonical-history.js'
import type { RunCoordination } from '../ports.js'
import { terminalRunStates } from '../run/lifecycle.js'

export async function activateNextInteractionForRun<C>(scope: RunCoordination<C>): Promise<RunEvent | null> {
  if (!scope.state || scope.state.context === null || scope.state.pending)
    return null
  while (scope.state.queuedInteractions.length) {
    const request = scope.state.queuedInteractions[0]!
    try {
      let pending = snapshotInteraction(await scope.ports.interactions.activate(scope.identity, request, scope.controller.signal), request.toolCall)
      if (pending.kind !== request.kind)
        throw new HarnessError('invalid_state', '交互类型不匹配')
      if (request.afterConfirmation)
        pending = { ...pending, afterConfirmation: true }
      const context = await scope.ports.context.afterTool(scope.state.context!, request.toolCall, { kind: 'waiting', interaction: pending }, scope.state.round)
      // 队列出队、活跃门、Canonical prompt替换与通知同一次提交；重启按request key重查激活。
      return (await scope.commit({ context, pending, status: 'waiting', queuedInteractions: scope.state.queuedInteractions.slice(1), resolution: null }, 'interaction_required', { interactionId: pending.id, kind: pending.kind, toolCallId: pending.toolCall.id }))!
    }
    catch (error) {
      if (scope.controller.signal.aborted || scope.persistenceUncertain)
        throw error
      return scope.applyTool(request.toolCall, { kind: 'completed', value: { status: 'error', code: 'interaction_unavailable' }, successful: false, mutated: false }, false, request.id)
    }
  }
  return null
}

export async function* closeInteractionsForRun<C>(scope: RunCoordination<C>, status: 'cancelled' | 'error', additional: readonly import("../index.js").PendingInteraction[] = []): AsyncGenerator<RunEvent> {
  if (!scope.state || scope.state.context === null)
    return
  const requests = [...additional, ...(scope.state.pending ? [scope.state.pending] : []), ...scope.state.queuedInteractions]
  const current = new Set([...additional, ...(scope.state.pending ? [scope.state.pending] : [])].map((item) => item.toolCall.id))
  const seen = new Set<string>()
  let context: C = scope.state.context
  for (const request of requests) {
    if (seen.has(request.toolCall.id))
      continue
    seen.add(request.toolCall.id)
    const toolStatus = status === 'error' && !current.has(request.toolCall.id) ? 'cancelled' : status
    context = await scope.ports.context.afterTool(context, request.toolCall, { kind: 'completed', value: { status: toolStatus }, successful: false, mutated: false }, scope.state.round)
    yield (await scope.commit({ context }, 'tool_done', { toolCallId: request.toolCall.id, name: request.toolCall.name, status: toolStatus }))!
  }
  await scope.commit({ pending: null, queuedInteractions: [], replayCall: null, resolution: null })
}

export async function* completeResolutionClosureForRun<C>(scope: RunCoordination<C>): AsyncGenerator<RunEvent> {
  const text = '好的，已取消这项操作，任务停在这里；前面完成的部分仍然有效，需要继续随时说一声。'
  while (scope.state?.resolutionClosure && !terminalRunStates.has(scope.state.status)) {
    const closure = scope.state.resolutionClosure
    const normal = closure.disposition === 'cancelled' && !closure.pending.afterConfirmation && closure.pending.kind !== 'credential'
    if (closure.step === 'close_tools') {
      for await (const event of scope.closeInteractions(closure.disposition === 'expired' ? 'error' : 'cancelled', [closure.pending]))
        yield event
      for await (const event of scope.closeTools(closure.disposition === 'expired' ? 'error' : 'cancelled', 'cancelled'))
        yield event
      await scope.commit({ resolutionClosure: { ...closure, step: normal ? 'start' : 'final' } })
    }
    else if (closure.step === 'start') {
      yield (await scope.commit({ round: closure.closingRound, text: '', resolutionClosure: { ...closure, step: 'text' } }, 'round_start'))!
    }
    else if (closure.step === 'text') {
      yield (await scope.commit({ text, roundTexts: [...scope.state.roundTexts, text], resolutionClosure: { ...closure, step: 'end' } }, 'token', { text }))!
    }
    else if (closure.step === 'end') {
      const context = await scope.ports.context.afterRound(scope.state.context!, { text, calls: [], contextInput: scope.state.usage.contextInput }, scope.state.round)
      yield (await scope.commit({ context, resolutionClosure: { ...closure, step: 'final' } }, 'round_end', { text }))!
    }
    else {
      yield await scope.finish(normal ? 'completed' : closure.disposition === 'expired' ? 'failed' : 'cancelled', closure.disposition === 'expired' ? 'interaction_expired' : null, normal ? text : closure.disposition === 'expired' ? closure.pending.kind === 'credential' ? '凭据输入已过期，请重新发起操作。' : '这次交互已过期，请重新告诉我你的选择。' : '')
    }
  }
}

/** 单次回执与等待状态同事务消费，取消/过期收尾不重复启动Provider。 */
export async function* resumeWaitingRun<C>(scope: RunCoordination<C>, resolution?: InteractionResolution): AsyncGenerator<RunEvent, boolean> {
  if (!scope.state) throw new HarnessError('invalid_state', '运行尚未建立')
  await scope.checkCancellation()
  if (!resolution)
    return true
  if (!scope.state.pending || resolution.interactionId !== scope.state.pending.id || !resolution.receiptId) {
    throw new HarnessError('conflict', '交互状态已失效')
  }
  if (scope.state.pending.kind === 'confirmation' && !['confirmed', 'cancelled', 'aborted', 'expired'].includes(resolution.status))
    throw new HarnessError('conflict', '交互类型不匹配')
  if (scope.state.pending.kind !== 'confirmation' && !['answered', 'cancelled', 'aborted', 'expired'].includes(resolution.status))
    throw new HarnessError('conflict', '交互类型不匹配')
  await scope.checkCancellation()
  if (scope.state.context === null)
    throw new HarnessError('invalid_state', '运行上下文缺失')
  const pending = scope.state.pending
  scope.dispatchedCalls.add(scope.dispatchKey(pending.toolCall))
  // 凭据由交互服务写入安全存储；Harness只接收据，不能把秘密写进checkpoint/Canonical。
  resolution = Object.freeze({
    interactionId: resolution.interactionId,
    receiptId: resolution.receiptId,
    status: resolution.status,
    value: pending.kind === 'credential' ? { status: resolution.status === 'answered' ? 'completed' : resolution.status }
      : pending.kind === 'confirmation' ? null : portableSnapshot(resolution.value),
  })
  const context = await scope.ports.context.resumeInteraction(scope.state.context, pending, resolution)
  const cancelled = resolution.status === 'cancelled'
  const aborted = resolution.status === 'aborted'
  const expired = resolution.status === 'expired'
  const closure: ResolutionClosure | null = cancelled || aborted || expired ? { disposition: resolution.status as ResolutionClosure['disposition'], pending, closingRound: scope.state.round + 1, step: 'close_tools' } : null
  const event = await scope.commit({
    context, resolution: pending.kind === 'confirmation' ? resolution : null, status: 'running', pending: null,
    replayCall: pending.kind === 'confirmation' && !cancelled && !expired && !aborted ? pending.toolCall : null,
    replayResultReady: false,
    completedToolCount: scope.state.completedToolCount + (pending.kind !== 'confirmation' && !cancelled && !expired && !aborted ? 1 : 0),
    resolutionClosure: closure,
  }, 'interaction_resolved', { interactionId: pending.id, status: resolution.status }, null, resolution.receiptId)
  yield event!
  if (cancelled || aborted || expired) {
    yield* scope.completeResolutionClosure()
    return true
  }
  if (pending.kind !== 'confirmation')
    yield (await scope.commit({}, 'tool_done', { toolCallId: pending.toolCall.id, name: pending.toolCall.name, status: 'success' }))!
  if (pending.kind !== 'confirmation') {
    const next = await scope.activateNextInteraction()
    if (next)
      yield next
    if (scope.state.pending)
      return true
  }

  return false
}
