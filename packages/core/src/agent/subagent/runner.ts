import { createCanonicalRunner } from '../runner.js'
import type { RunCheckpoint, PrepareContextInput } from '../models.js'
import type { DelegatedAgentLaunch, DelegatedAgentOutcome } from './contracts.js'

type RunnerOptions = Parameters<typeof createCanonicalRunner>[0]

export interface DelegatedAgentPreset {
  readonly agentId: string
  readonly toolNames: readonly string[]
  prepareContext(launch: DelegatedAgentLaunch, signal: AbortSignal): Promise<PrepareContextInput>
}

/** 从子 Run 已提交的 checkpoint 投影交付结果。 */
export function delegatedTerminalOutcome(state: Pick<RunCheckpoint<unknown>, 'status' | 'text' | 'errorCode'>): DelegatedAgentOutcome | null {
  if (state.status === 'completed') return { status: 'completed', finalMessage: state.text }
  if (state.status === 'cancelled') return { status: 'cancelled', reasonCode: 'cancelled' }
  if (state.status === 'failed' || state.status === 'unknown')
    return { status: 'failed', reasonCode: state.errorCode ?? (state.status === 'unknown' ? 'provider_result_unknown' : 'incomplete_run') }
  return null
}

/** 由普通派单器驱动的子会话 Runner。 */
export function createDelegatedAgentHarness(preset: DelegatedAgentPreset, launch: DelegatedAgentLaunch, options: RunnerOptions,
  onPrepared: (tools: readonly string[]) => void = () => {}) {
  const { identity } = launch
  const observation = options.runtime.observation
  return createCanonicalRunner({
    ...options,
    context: {
      ...options.context,
      compactionHistory: 'latest',
      async load(candidate, signal) {
        if (candidate.ownerId !== identity.ownerId || candidate.runId !== identity.runId || candidate.sessionId !== identity.sessionId)
          throw new Error('子 Agent 运行身份不匹配')
        const loaded = await options.context.load(candidate, signal)
        if ('kind' in loaded) throw new Error('子 Agent 模型上下文不可用')
        if (loaded.modelIdentity !== launch.modelIdentity) throw new Error('子 Agent 模型绑定不匹配')
        const allowed = new Set<string>([...preset.toolNames, 'shell', 'agent_message'])
        const tools = (loaded.capabilities?.tools ?? []).filter(tool => allowed.has(tool.name))
        const input = await preset.prepareContext(launch, signal)
        if (launch.previousRunId) {
          const previous = await options.runtime.store.read({ ...identity, runId: launch.previousRunId })
          if (previous?.status !== 'completed' || !previous.context) throw new Error('子会话历史无法恢复')
          const entries = previous.context.prepared.area.entries.filter(entry =>
            entry.persistencePolicy !== 'request_only' && ['user', 'assistant', 'tool'].includes(entry.message.role))
          const history = entries.map((entry, index) => ({
            ownerId: identity.ownerId, sessionId: identity.sessionId, id: String(index + 1),
            conversationSeq: index + 1, role: entry.message.role,
            content: entry.message.content, contentJson: entry.message.content,
            roundId: entry.roundId, canonicalBatchId: entry.batchId, source: entry.source,
          }))
          if (previous.text && !history.some(row => row.role === 'assistant' && row.content === previous.text)) {
            const sequence = history.length + 1
            history.push({
              ownerId: identity.ownerId, sessionId: identity.sessionId, id: String(sequence),
              conversationSeq: sequence, role: 'assistant', content: previous.text, contentJson: previous.text,
              roundId: null, canonicalBatchId: null, source: 'restored_history',
            })
          }
          input.history = history
        }
        onPrepared(tools.map(tool => tool.name))
        return {
          modelIdentity: loaded.modelIdentity, contextWindow: loaded.contextWindow, accessScopeHash: loaded.accessScopeHash,
          input,
          capabilities: { toolNames: tools.map(tool => tool.name), tools },
        }
      },
    },
    runPreparation: undefined,
    runtime: {
      ...options.runtime,
      observation: observation ? {
        record(event) {
          observation.record({
            ...event,
            attributes: {
              ...event.attributes,
              subagent_trace: {
                agent_id: preset.agentId,
                child_id: launch.childId,
                parent_session_id: launch.parent.sessionId,
                parent_run_id: launch.parent.runId,
              },
            },
          })
        },
      } : undefined,
      acceptsAgentInbox: true,
      subagentTerminalDelivery(checkpoint) {
        const outcome = delegatedTerminalOutcome(checkpoint)
        if (!outcome) return undefined
        return { parent: launch.parent, outcome }
      },
    },
  })
}
