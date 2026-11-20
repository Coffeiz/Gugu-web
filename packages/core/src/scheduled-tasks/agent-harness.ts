import { AgentRunError, RunStoreRejected, isEarlyExit,
  type CanonicalMessage, type CanonicalRunContext, type Lease, type PreparationIdentity, type RunCheckpoint, type RunEvent, type RunIdentity } from '../agent/models.js'
import { createCanonicalRunLoader } from '../agent/context/prepare.js'
import { stableJson } from '../agent/context/history/canonical-history.js'
import type { CanonicalContextPorts } from '../agent/ports.js'
import { createAgentRuntime, type AgentRuntimeOptions } from '../agent/runtime.js'
import type { AssertScheduledTaskLease } from './runner.js'
import type { ProviderConfig } from '../agent/providers/contracts.js'

type AttemptRuntime = Omit<AgentRuntimeOptions['runtime'], 'store' | 'leases' | 'cancellation' | 'interactions' | 'publish'>

/** 定时任务不持久化模型推理续接；模型选择和凭据仍由可信 Host 提供。 */
export function scheduledTaskProviderSelection<T extends { config: ProviderConfig }>(selected: T): T {
  return { ...selected, config: { ...selected.config, reasoning_persistence: 'off' } }
}

/** 单次定时尝试不创建会话历史。任务租约和最终状态仍由外层 ScheduledTaskRunner 管理。 */
export function createScheduledTaskHarness(options: Omit<AgentRuntimeOptions, 'runtime'> & {
  identity: RunIdentity
  leaseToken: string
  assertScheduledLease?: AssertScheduledTaskLease
  runtime: AttemptRuntime
}) {
  const { identity, leaseToken, runPreparation } = options
  const expected = { ...identity }
  const taskId = /^scheduled-task:([1-9]\d*)$/u.exec(expected.sessionId)?.[1]
  if (!taskId || !leaseToken) throw new AgentRunError('invalid_state', '定时任务运行身份无效')
  function assertSubject(subject: PreparationIdentity | undefined): void {
    if (subject?.ownerId !== expected.ownerId || subject.subject.kind !== 'scheduled_task' || subject.subject.id !== taskId)
      throw new AgentRunError('invalid_state', '定时任务工具授权主体不匹配')
  }
  const owns = (candidate: RunIdentity) => candidate.ownerId === expected.ownerId
    && candidate.sessionId === expected.sessionId && candidate.runId === expected.runId
  const assertOwned = (candidate: RunIdentity) => {
    if (!owns(candidate)) throw new RunStoreRejected('not_found')
  }
  async function assertScheduledLease(signal: AbortSignal) {
    signal.throwIfAborted()
    try { await options.assertScheduledLease?.() }
    catch { throw new AgentRunError('lease_lost', '定时任务执行租约已失效') }
    signal.throwIfAborted()
  }
  let active = false
  let closed = false
  let cancelled = false
  let notify: (() => void) | undefined
  let checkpoint: RunCheckpoint<CanonicalRunContext> | null = null
  let request: { prefix: CanonicalMessage[]; dynamicTail: CanonicalMessage[]; systemPrompt?: string } | null = null
  const events = new Map<string, RunEvent>()
  const toolInputs = new Map<string, string>()
  const unresolvedToolErrors = new Set<string>()

  function assertLease(candidate: RunIdentity, lease: Lease): void {
    assertOwned(candidate)
    if (closed || !active || lease.token !== leaseToken || lease.fence !== 1) throw new RunStoreRejected('lease_lost')
  }

  function save(next: RunCheckpoint<CanonicalRunContext>, batch: readonly RunEvent[]) {
    assertOwned(next.identity)
    for (const event of batch) assertOwned(event.identity)
    const copy = structuredClone(next)
    const output = structuredClone(batch)
    checkpoint = copy
    for (const event of output) {
      events.set(event.id, event)
      const { toolCallId, name, status } = event.payload
      if (typeof toolCallId !== 'string' || typeof name !== 'string') continue
      if (event.type === 'tool_call') {
        const call = copy.calls.find(candidate => candidate.id === toolCallId)
        if (call && !call.parseError) toolInputs.set(toolCallId, stableJson([name, call.input ?? {}]))
      } else if (event.type === 'tool_done') {
        const key = toolInputs.get(toolCallId) ?? stableJson([name, null, toolCallId])
        if (status === 'success') unresolvedToolErrors.delete(key)
        if (status === 'error') unresolvedToolErrors.add(key)
        toolInputs.delete(toolCallId)
      }
    }
  }

  const loadContext: CanonicalContextPorts['load'] = async (candidate, signal) => {
    assertOwned(candidate)
    const loaded = await options.context.load(candidate, signal)
    if (isEarlyExit(loaded)) return loaded
    const { input } = loaded
    if (input.history.length || input.currentUsersInHistory || input.resumeInteraction
      || input.currentUser?.persistedMessageId != null || input.currentUsers?.some(user => user.persistedMessageId != null))
      throw new AgentRunError('invalid_state', '定时任务不能继承会话消息')
    if (loaded.capabilities?.subject || (!runPreparation && loaded.capabilities?.toolNames.length))
      assertSubject(loaded.capabilities?.subject)
    return { ...loaded, sourceEffects: undefined, input: { ...input, entryKind: 'scheduled_task' } }
  }
  const prepare = runPreparation ? createCanonicalRunLoader(loadContext, {
    ...runPreparation,
    async configuration(candidate, signal) {
      assertOwned(candidate)
      const configuration = await runPreparation.configuration(candidate, signal)
      assertSubject(configuration.identity)
      return configuration
    },
  }, { ...options.context.preparation, digest: options.context.digest, nextId: options.context.nextId }, options.observation) : loadContext

  const runtime = createAgentRuntime({
    observation: options.observation,
    context: {
      ...options.context,
      async load(candidate, signal) {
        const loaded = await prepare(candidate, signal)
        if (isEarlyExit(loaded)) return loaded
        const { input } = loaded
        // 标准能力准备可能扩展提示词。冻结最终前缀，Provider 续轮复用同一次 owner 快照。
        const prefix = [...input.fixedPrefix]
        if (input.systemInMessages && input.systemPrompt) prefix.unshift({ role: 'system', content: input.systemPrompt })
        const dynamicTail: CanonicalMessage[] = input.extraReminder
          ? [{ role: 'user', content: `[system-reminder]\n${input.extraReminder}\n[/system-reminder]` }]
          : []
        request = structuredClone({ prefix, dynamicTail, systemPrompt: input.systemInMessages ? '' : input.systemPrompt })
        return loaded
      },
      async prepareRequest(candidate, signal) {
        assertOwned(candidate)
        signal?.throwIfAborted()
        if (!request) throw new AgentRunError('invalid_state', '定时任务上下文尚未准备')
        const { prefix, dynamicTail } = request
        return structuredClone({ prefix, dynamicTail })
      },
    },
    executor: options.executor,
    provider: {
      ...options.provider,
      async resolve(candidate, modelIdentity, signal) {
        assertOwned(candidate)
        await assertScheduledLease(signal)
        const selected = scheduledTaskProviderSelection(await options.provider.resolve(candidate, modelIdentity, signal))
        return {
          ...selected,
          ...(request?.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
        }
      },
    },
    runtime: {
      ...options.runtime,
      tools: {
        ...options.runtime.tools,
        async dispatch(call, scope) {
          assertOwned(scope.identity)
          await assertScheduledLease(scope.signal)
          return options.runtime.tools.dispatch(call, {
            ...scope,
            async execute(command) {
              await assertScheduledLease(scope.signal)
              return scope.execute(command)
            },
          })
        },
      },
      store: {
        async read(candidate) { return !closed && owns(candidate) ? structuredClone(checkpoint) : null },
        async create(next, lease, batch) {
          assertLease(next.identity, lease)
          if (checkpoint) throw new RunStoreRejected('conflict')
          save(next, batch)
        },
        async commit(change) {
          assertLease(change.identity, change.lease)
          if (checkpoint?.version !== change.expectedVersion || change.interactionReceipt !== null)
            throw new RunStoreRejected('conflict')
          save(change.checkpoint, change.events)
        },
        async pendingEvents(candidate) {
          assertOwned(candidate)
          return structuredClone([...events.values()])
        },
        async acknowledgeEvents(candidate, ids) {
          assertOwned(candidate)
          for (const id of ids) events.delete(id)
        },
      },
      leases: {
        async acquire(candidate) {
          assertOwned(candidate)
          if (closed || active || checkpoint) return null
          active = true
          return { token: leaseToken, fence: 1 }
        },
        async assert(candidate, lease) { assertLease(candidate, lease) },
        async release(candidate, lease) { assertLease(candidate, lease); active = false },
      },
      cancellation: {
        async isRequested(candidate) { assertOwned(candidate); return cancelled },
        async request(candidate) { assertOwned(candidate); cancelled = true },
        async notify(candidate) { assertOwned(candidate); notify?.() },
        async subscribe(candidate, listener) {
          assertOwned(candidate)
          notify = listener
          return () => { notify = undefined }
        },
      },
      interactions: { async activate() { throw new AgentRunError('invalid_state', '定时任务不能等待交互确认') } },
      async publish() { /* 定时尝试只向外层返回最终结果。 */ },
    },
  })
  return {
    harness: { start: runtime.harness.start },
    hasUnresolvedToolErrors: () => unresolvedToolErrors.size > 0,
    async close() {
      closed = true
      checkpoint = null
      request = null
      events.clear()
      toolInputs.clear()
      unresolvedToolErrors.clear()
      notify = undefined
      await runtime.close()
    },
  }
}
