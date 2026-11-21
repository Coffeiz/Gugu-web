import { createHash, randomUUID } from 'node:crypto'
import { CoreError, DEFAULT_LLM_CONTEXT_TOKENS } from '../../../../../packages/core/src/contracts/index.js'
import { stableJson } from '../../../../../packages/core/src/agent/context/history/canonical-history.js'
import { readAgentPromptSet } from '../../../../../packages/core/src/agent/context/prompts.js'
import { agentPromptPreferenceFields } from '../../../../../packages/core/src/agent/context/prompt-format.js'
import { createWebAgentContextBuilder } from '../../../../../packages/core/src/agent/context/builder.js'
import type { ProviderConfig } from '../../../../../packages/core/src/agent/providers/contracts.js'
import { ProviderError, providerErrorMessage } from '../../../../../packages/core/src/agent/providers/errors.js'
import { ProviderStreamSanitizer, stripThinking } from '../../../../../packages/core/src/agent/providers/sanitize.js'
import { createNodeProviderTransportFactory, desktopModelTransportOptions, type NodeProviderTransportOptions } from '../../../../../packages/core/src/agent/providers/transport/node.js'
import { createTimeTool, createListProjectsTool, createListEventsTool, createClientTools } from '../../../../../packages/core/src/agent/tools/index.js'
import { createAgentCalendarReader } from '../../../../../packages/core/src/calendar/application/event-read.js'
import { createKyselyCalendarAgentReadPort } from '../../../../../packages/core/src/calendar/read-store.js'
import { readDesktopScheduleImTargets, type DesktopScheduleImTarget } from '../../../../../packages/core/src/scheduled-tasks/desktop-im.js'
import type { ScheduledTaskExecutionPlan } from '../../../../../packages/core/src/scheduled-tasks/run-now-read.js'
import type { ToolDefinition } from '../../../../../packages/core/src/agent/tools/index.js'
import { createScheduledTaskContextLoader, createScheduledTaskAgentAttempt, createScheduledTaskHarness, createScheduledTaskExecution, createScheduledTaskRunToolPorts } from '../../../../../packages/core/src/scheduled-tasks/run-now.js'
import type { DesktopAgentRuntimePort } from '../../../../../packages/core/src/runtime/desktop-agent-port.js'
import type { AgentObservationPort } from '../../../../../packages/core/src/agent/observation.js'
import type { CanonicalRunContext } from '../../../../../packages/core/src/agent/models.js'
import type { SqlDataRuntime } from '../../../../../packages/core/src/data/runtime.js'

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
const unavailable = async (): Promise<never> => { throw new CoreError('conflict', '定时任务未开放此能力') }

export function createDesktopScheduledAgent(options: {
  core: SqlDataRuntime
  promptDirectory: string
  observation?: AgentObservationPort
  model(): Promise<ProviderConfig>
  resolveProxy?: NodeProviderTransportOptions['resolveProxy']
  contextData: Pick<Parameters<typeof createScheduledTaskContextLoader>[0]['data'], 'loadStylePreferences' | 'loadMemory' | 'loadImChannels'>
  authorizeIm(target: DesktopScheduleImTarget): Promise<{ groupMemoryEnabled: boolean; groupHistorySearchEnabled: boolean } | null>
  deliverIm(target: DesktopScheduleImTarget, text: string): Promise<void>
  loadGroupStyle?: Parameters<typeof createScheduledTaskContextLoader>[0]['loadGroupStyle']
  loadGroupMemory?: (task: ScheduledTaskExecutionPlan) => Promise<string>
  groupTools?(task: ScheduledTaskExecutionPlan): ToolDefinition[]
  filterTools(names: readonly string[]): Promise<readonly string[]>
}): DesktopAgentRuntimePort['runScheduledInstruction'] {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const clock = { now: () => new Date(), timezone: async () => timezone }
  const definitions = [
    createTimeTool(clock),
    createListProjectsTool(options.core),
    createListEventsTool(createAgentCalendarReader(createKyselyCalendarAgentReadPort(options.core.db, 'sqlite'))),
    ...createClientTools(options.core).filter(tool => tool.effect === 'read'),
  ]
  return async (task, isTrial, assertLease) => {
    await assertLease()
    const targets = readDesktopScheduleImTargets(task.deliveryTargets, task.channels)
    const target = targets.find(candidate => candidate.chatType === 'group')
    const scope = task.groupScope
    if (target?.chatType === 'group' ? !scope || scope.scopeId !== target.recipient || scope.ownerId !== task.ownerId
      || scope.platform !== target.platform || scope.botId !== target.botId : Boolean(scope))
      throw new CoreError('conflict', '定时任务的群聊范围无效')
    const assertTarget = async () => {
      await assertLease()
      if (!(await Promise.all(targets.map(candidate => options.authorizeIm(candidate)))).every(Boolean))
        throw new CoreError('conflict', '定时任务的 IM 投递授权已变化')
    }
    await assertTarget()
    const config = await options.model()
    const modelIdentity = digest([config.provider, config.api_format, config.base_url, config.model])
    const allowed = new Set(await options.filterTools(definitions.map(tool => tool.definition.name)))
    let result: { text: string; status: 'success' | 'failed' } | undefined
    const execute = createScheduledTaskExecution({
      timeZone: timezone,
      loadGroupMemory: options.loadGroupMemory,
      attempt: createScheduledTaskAgentAttempt<CanonicalRunContext>(async ({ prompt }) => {
        const identity = { ownerId: task.ownerId, sessionId: `scheduled-task:${task.id}`, runId: randomUUID() }
        const accessScopeHash = digest(identity)
        const { tools, preparation } = createScheduledTaskRunToolPorts({
          identity, task, assertLease: assertTarget, isCurrent: async () => true,
          definitions: task.groupScope
            ? [...definitions.filter(tool => tool.definition.name === 'get_current_time'), ...(options.groupTools?.(task) ?? [])]
            : definitions.filter(tool => allowed.has(tool.definition.name)),
          isGroupMemoryCurrent: async () => Boolean(scope && target && (await options.authorizeIm(target))?.groupMemoryEnabled),
          isGroupScopeCurrent: async () => Boolean(scope && target && (await options.authorizeIm(target))?.groupHistorySearchEnabled),
        })
        const harness = createScheduledTaskHarness({
          identity, leaseToken: identity.runId, assertScheduledLease: assertTarget, observation: options.observation,
          runPreparation: preparation,
          context: {
            digest, nextId: randomUUID,
            load: async (candidate, signal) => {
              await assertTarget()
              const load = createScheduledTaskContextLoader({
                identity, task, prompt, memoryEnabled: true, now: Date.now, currentTimeReminder: false,
                model: { modelIdentity, accessScopeHash,
                  contextWindow: typeof config.context_tokens === 'number' ? config.context_tokens : DEFAULT_LLM_CONTEXT_TOKENS },
                data: { ...options.contextData, loadTimezone: clock.timezone },
                loadGroupStyle: options.loadGroupStyle,
                builder: createWebAgentContextBuilder({
                  now: Date.now,
                  staticPrompt: (selection, _identity, style) => ({
                    ...readAgentPromptSet(options.promptDirectory), timezone, skillIndex: '', now: clock.now(),
                    locale: selection.locale, groupChat: selection.groupChat, imChat: targets.length > 0,
                    ...agentPromptPreferenceFields(style),
                  }),
                  sessionInfo: () => ({}),
                  systemInMessages: () => false,
                }, null, { includeScopedContext: true, includeOwnerOverview: false }),
              })
              const context = await load(candidate, signal)
              await assertTarget()
              return context
            },
            references: { async dehydrate(entry) { return entry.message }, async hydrate(entry) { return entry.message } },
            finalization: { async complete() {} },
            preparation: { async buildRag() { return { tail: [] } } },
            prepareRequest: unavailable, compaction: { summarize: unavailable }, currentRequest: () => null,
            stageContinuation: unavailable, async releaseContinuations() {}, diagnoseCompactionFailure() {},
          },
          executor: { authorize: unavailable, executor: { execute: unavailable } },
          runtime: {
            tools, clock: { now: () => new Date().toISOString() },
            sanitizeText: stripThinking, createStreamSanitizer: () => new ProviderStreamSanitizer(),
            presentError: error => error instanceof ProviderError
              ? { code: error.code, text: providerErrorMessage(error) }
              : { code: 'agent_failed', text: '定时任务指令执行失败' },
            presentToolResult: async value => value, diagnose() {},
          },
          provider: {
            async resolve() { return { config, modelIdentity, accessScopeHash, systemPrompt: '' } },
            transportFactory: createNodeProviderTransportFactory(desktopModelTransportOptions(config, options.resolveProxy)),
          },
        })
        return { identity, ...harness }
      }),
      async deliver(_task, { text, status }) {
        if (status === 'success') {
          for (const recipient of targets) {
            await assertTarget()
            await options.deliverIm(recipient, text)
          }
        }
        result = { text, status }
        return {}
      },
    })
    await execute(task, isTrial, assertLease)
    if (!result) throw new CoreError('storage_error', '定时任务未返回执行结果')
    return result
  }
}
