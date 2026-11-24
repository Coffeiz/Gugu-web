import type { RunIdentity } from '../models.js'
import type { RunStore } from '../ports.js'
import type { createAgentInbox } from './inbox.js'
import type { createSubagentDeliveryStore } from './delivery-store.js'
import type { DelegatedAgentInput } from './contracts.js'
import { delegatedTerminalOutcome } from './runner.js'
import { searcherDefinition } from './searcher/definition.js'
import { toolDisplayIdentity } from '../sessions/tool-labels.js'
import { searcherModuleIds } from './searcher/context.js'

export class SubagentServiceError extends Error {
  constructor(readonly code: 'RUN_NOT_FOUND' | 'AGENT_NOT_FOUND' | 'AGENT_UNAVAILABLE' | 'RUN_TERMINAL' | 'ROUND_NOT_FOUND') {
    super({ RUN_NOT_FOUND: '子运行不存在', AGENT_NOT_FOUND: '子 Agent ID 无效，请使用目录中的 ID', AGENT_UNAVAILABLE: '子 Agent 当前不可用',
      RUN_TERMINAL: '子运行已结束', ROUND_NOT_FOUND: '轮次不存在' }[code])
  }
}

function startInputKey(agentId: string, input: DelegatedAgentInput): string {
  const base = [agentId, input.task, input.resourceRefs ?? []]
  // 旧派单的缺省选项与显式 false 具有相同的幂等键。
  return JSON.stringify(input.allowBackgroundReport ? [...base, true] : base)
}

/** 父子通信只读写持久记录，执行归普通 Agent 调度。 */
export function createSubagentService(ports: {
  deliveries: Pick<ReturnType<typeof createSubagentDeliveryStore>, 'admit' | 'read' | 'childIdentity' | 'readLaunch' | 'pending'
    | 'resolveConversation' | 'list' | 'listConversations' | 'continueConversation' | 'activeExecutions'>
  inbox: Pick<ReturnType<typeof createAgentInbox>, 'send' | 'pending'>
  childCheckpoints: Pick<RunStore<unknown>, 'read'>
  requestCancellation(identity: RunIdentity): Promise<void>
  schedule(): Promise<void>
  parentBinding(identity: RunIdentity): Promise<{ agentId: string; modelIdentity: string; workspaceFingerprint?: string } | null>
  authorizeResources(identity: RunIdentity, refs: readonly string[]): Promise<boolean>
}) {
  async function binding(identity: RunIdentity) {
    const parent = await ports.parentBinding(identity)
    if (!parent || !searcherDefinition.allowedParentAgentIds.some(id => id === parent.agentId))
      throw new SubagentServiceError('AGENT_UNAVAILABLE')
    return parent
  }

  async function notifySchedule() {
    try { await ports.schedule() }
    catch { /* 派单已提交，普通调度可以重新扫描。 */ }
  }

  return {
    async catalog(identity: RunIdentity) {
      try { await binding(identity) }
      catch (error) { if (error instanceof SubagentServiceError) return []; throw error }
      return [{ id: searcherDefinition.id, name: searcherDefinition.name, description: searcherDefinition.description }]
    },
    async spawn(parent: RunIdentity, callId: string, agentId: string, input: DelegatedAgentInput, signal: AbortSignal) {
      const bound = await binding(parent)
      if (agentId !== searcherDefinition.id && agentId !== 'searcher')
        throw new SubagentServiceError('AGENT_NOT_FOUND')
      if (!await ports.authorizeResources(parent, input.resourceRefs ?? []))
        throw new SubagentServiceError('AGENT_UNAVAILABLE')
      signal.throwIfAborted()
      const admitted = await ports.deliveries.admit(parent, callId, startInputKey(searcherDefinition.id, input),
        { input, modelIdentity: bound.modelIdentity, workspaceFingerprint: bound.workspaceFingerprint })
      if (admitted.status === 'queued' || admitted.status === 'running') await notifySchedule()
      return { action: 'spawn' as const, run: {
        childId: admitted.childId, agentId: searcherDefinition.id, status: admitted.status, updatedAt: admitted.updatedAt,
      } }
    },
    async send(parent: RunIdentity, callId: string, childId: string, message: string, signal: AbortSignal) {
      const bound = await binding(parent)
      signal.throwIfAborted()
      const replay = await ports.inbox.send(parent, { childId }, callId, message, true)
      if (replay) return { action: 'send' as const, childId, ...replay }
      const next = await ports.deliveries.continueConversation(parent, childId, callId, {
        modelIdentity: bound.modelIdentity, workspaceFingerprint: bound.workspaceFingerprint,
        input: { task: message },
      })
      if (next) {
        await notifySchedule()
        return { action: 'send' as const, childId, started: true as const }
      }
      const saved = await ports.inbox.send(parent, { childId }, callId, message)
      if (!saved) {
        const delivery = (await ports.deliveries.resolveConversation(parent, childId))?.delivery
          ?? await ports.deliveries.read(parent, childId)
        throw new SubagentServiceError(delivery?.outcome ? 'RUN_TERMINAL' : 'RUN_NOT_FOUND')
      }
      return { action: 'send' as const, childId, ...saved }
    },
    async sendToParent(child: RunIdentity, callId: string, message: string, signal: AbortSignal) {
      signal.throwIfAborted()
      const saved = await ports.inbox.send(child, { parent: true }, callId, message)
      if (!saved) throw new SubagentServiceError('RUN_NOT_FOUND')
      return { action: 'send' as const, target: 'parent' as const, ...saved }
    },
    async waitInbox(identity: RunIdentity, signal: AbortSignal) {
      signal.throwIfAborted()
      const messages = await ports.inbox.pending(identity)
      const finals = await ports.deliveries.pending(identity)
      signal.throwIfAborted()
      return { messages: messages.map(({ id }) => id), finals: finals.map(({ childId, status }) => ({ childId, status })) }
    },
    async wait(parent: RunIdentity, childId: string, signal: AbortSignal) {
      await binding(parent)
      let deliveryRunId: string | undefined
      let saved = await ports.deliveries.read(parent, childId)
      if (!saved) {
        const conversation = await ports.deliveries.resolveConversation(parent, childId)
        if (conversation) {
          const launch = await ports.deliveries.readLaunch(conversation.parent, conversation.delivery.runId, true)
          if (launch?.input.allowBackgroundReport) {
            saved = conversation.delivery
            deliveryRunId = saved.runId
          }
        }
      }
      signal.throwIfAborted()
      if (!saved?.outcome) throw new SubagentServiceError(saved ? 'AGENT_UNAVAILABLE' : 'RUN_NOT_FOUND')
      return saved.consumed ? { childId, status: saved.outcome.status, alreadyDelivered: true as const }
        : { ...saved.outcome, ...(deliveryRunId ? { deliveryRunId } : {}) }
    },
    async cancel(parent: RunIdentity, childId: string) {
      await binding(parent)
      const conversation = await ports.deliveries.resolveConversation(parent, childId)
      if (!conversation) throw new SubagentServiceError('RUN_NOT_FOUND')
      const { delivery, parent: origin } = conversation
      if (delivery.outcome) return { childId, status: delivery.outcome.status }
      const execution = await ports.deliveries.childIdentity(origin, delivery.runId)
      if (!execution) throw new SubagentServiceError('AGENT_UNAVAILABLE')
      await ports.requestCancellation(execution)
      return { childId, status: 'cancelling' as const }
    },
    async inspect(parent: RunIdentity, childId?: string, roundNumber?: number, lastRounds = 1, presentation = false) {
      await binding(parent)
      if (childId === undefined) {
        const runs = await ports.deliveries.listConversations(parent) ?? await ports.deliveries.list(parent)
        return { view: 'list' as const, runs: runs.map(({ runId: _runId, ...run }) => ({ ...run, agentId: searcherDefinition.id })) }
      }
      const conversation = await ports.deliveries.resolveConversation(parent, childId)
      const origin = conversation?.parent ?? parent
      const saved = conversation?.delivery ?? await ports.deliveries.read(parent, childId)
      if (!saved) throw new SubagentServiceError('RUN_NOT_FOUND')
      const identity = await ports.deliveries.childIdentity(origin, saved.runId)
      const checkpoint = identity && await ports.childCheckpoints.read(identity)
      const outcome = saved.outcome ?? (checkpoint ? delegatedTerminalOutcome(checkpoint) : null)
      const status = outcome?.status ?? (checkpoint?.status === 'running' || checkpoint?.status === 'waiting' ? checkpoint.status : saved.status)
      const finalMessage = presentation && outcome && 'finalMessage' in outcome
        ? outcome.finalMessage?.trim() : undefined
      const run = { childId, agentId: searcherDefinition.id, status, updatedAt: saved.updatedAt }
      const summarizeRound = (number: number) => {
        const current = number === checkpoint?.round
        const items = (checkpoint?.displayTimeline ?? []).filter(item => item.roundId === `${saved.runId}:${number}`)
        return {
          number,
          status: current ? outcome?.status ?? checkpoint?.status : 'completed',
          modelCall: { status: current && checkpoint?.phase === 'provider' ? 'running' : 'completed' },
          messages: items.filter(item => item.kind === 'assistant' && item.text && (!finalMessage || item.text.trim() !== finalMessage)).slice(-2)
            .map(item => item.text!.slice(0, 600)),
          toolCalls: items.filter(item => item.kind === 'tool' && item.toolName).slice(-8)
            .map(item => ({ name: presentation ? toolDisplayIdentity(item.toolName, item.toolInput).name : item.toolName!,
              status: item.toolStatus ?? 'unknown',
              ...(item.toolDurationMs !== undefined ? { elapsedMs: item.toolDurationMs } : {}) })),
        }
      }
      if (roundNumber !== undefined) {
        if (!checkpoint || !Number.isSafeInteger(roundNumber) || roundNumber < 1 || roundNumber > checkpoint.round)
          throw new SubagentServiceError('ROUND_NOT_FOUND')
        return { view: 'round' as const, run, round: summarizeRound(roundNumber) }
      }
      const roundsUsed = checkpoint?.round ?? 0
      const count = Math.min(roundsUsed, lastRounds)
      const rounds = Array.from({ length: count }, (_, index) => summarizeRound(roundsUsed - count + index + 1))
      const launch = await ports.deliveries.readLaunch(origin, saved.runId, true)
      return { view: 'run' as const, run, rounds,
        ...(presentation ? { task: launch?.input.task, finalMessage } : {}),
        ...(checkpoint?.pending ? { waitingFor: checkpoint.pending.kind } : {}),
        ...(launch ? { model: { id: launch.modelIdentity, selection: 'inherited' } } : {}),
        context: { moduleIds: checkpoint?.context ? [...searcherModuleIds] : [], inputRefCount: launch?.input.resourceRefs?.length ?? 0 },
        budget: { roundsUsed: checkpoint?.round ?? 0, maxRounds: checkpoint ? checkpoint.maxRounds : null },
        ...(outcome ? { result: 'reasonCode' in outcome ? { status: outcome.status, reasonCode: outcome.reasonCode }
          : { status: outcome.status, ...(outcome.reportRef ? { reportRef: outcome.reportRef } : {}) } } : {}),
      }
    },
    async cancelChildren(parent: RunIdentity) {
      const executions = await ports.deliveries.activeExecutions(parent)
      const results = await Promise.allSettled(executions.map(execution => ports.requestCancellation(execution)))
      if (results.some(result => result.status === 'rejected')) throw new Error('子运行取消请求未全部提交')
    },
  }
}
