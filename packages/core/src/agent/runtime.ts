import { createCanonicalRunner } from './runner.js'
import type { CanonicalRunContext } from './models.js'
import type { CanonicalContextPorts, CanonicalRunPreparationPorts, AgentRunnerPorts } from './ports.js'
import type { HarnessExecutorPorts } from './executor/contracts.js'
import { connectProviderHarness, connectProviderHarnessWithContextFactory } from './providers/runtime.js'
import type { ProviderRuntimeOptions, ProviderContextFactoryInput } from './providers/runtime.js'
import { createAgentChatService, type AgentChatServicePorts } from './chat-service.js'
import { createAgentDispatchSupervisor, type AgentDispatchSupervisorPorts } from './run/dispatch-supervisor.js'
import { createAgentDispatchWorker, type AgentDispatchRuntimeLease, type AgentDispatchWorkerPorts } from './run/dispatch-worker.js'
import type { AgentObservationPort } from './observation.js'

/**
 * 同一可信模型绑定下供 Host 摘要、反思等后台分支复用的 Provider 能力。
 * 不包含密钥读取或模型选择；每个调用仍须传入原 Run 的模型身份。
 */
export type AgentProviderAuxiliaryPorts = Pick<ReturnType<typeof connectProviderHarness>['provider'],
  'branchProvider' | 'reflectionProjection' | 'summaryProjection' | 'completeText'>

/** Agent Harness 的可移植组合入口；可信身份、存储、授权和执行能力由 Host 注入。 */
export interface AgentRuntimeOptions {
  /** Host 注入的通用非阻塞诊断观测端口。 */
  observation?: AgentObservationPort
  context: CanonicalContextPorts
  runPreparation?: CanonicalRunPreparationPorts
  executor: HarnessExecutorPorts
  runtime: Omit<AgentRunnerPorts<CanonicalRunContext>, 'context' | 'execution' | 'reply' | 'provider'>
  provider: Omit<ProviderRuntimeOptions, 'references' | 'prepareRequest' | 'digest' | 'nextId'>
}

/** 同一组上下文端口同时供 Provider 与 Harness 使用，避免模型身份或历史分叉。 */
export function createAgentRuntime(options: AgentRuntimeOptions) {
  const observation = options.observation ?? options.runtime.observation ?? options.provider.observation
  const connected = connectProviderHarness(options.context, { ...options.provider, observation })
  const harness = createCanonicalRunner({
    context: connected.context,
    runPreparation: options.runPreparation,
    executor: options.executor,
    runtime: { ...options.runtime, observation, provider: connected.provider },
  })
  return { harness, provider: connected.provider, close: () => connected.provider.close() }
}

/** 持久 Chat、调度执行与恢复共用一个 Worker；Host 提供端口并显式启停。 */
export function createAgentDispatchRuntime<C, L extends AgentDispatchRuntimeLease, I>(options: {
  chat: Omit<AgentChatServicePorts<C, I>, 'harness' | 'dispatch' | 'active'>
  worker: Omit<AgentDispatchWorkerPorts<C, L>, 'dispatch' | 'failStart'>
  dispatch: AgentDispatchWorkerPorts<C, L>['dispatch']
    & Pick<AgentChatServicePorts<C, I>, 'active'>
    & Pick<NonNullable<AgentChatServicePorts<C, I>['dispatch']>, 'requestCancel' | 'retryReconstruction'>
    & { failStart: AgentDispatchWorkerPorts<C, L>['failStart']; listReady: AgentDispatchSupervisorPorts['listReady'] }
  supervisor: Omit<AgentDispatchSupervisorPorts, 'kick' | 'listReady'>
}) {
  const { dispatch } = options
  const worker = createAgentDispatchWorker({ ...options.worker, dispatch, failStart: lease => dispatch.failStart(lease) })
  const supervisor = createAgentDispatchSupervisor({ ...options.supervisor, listReady: limit => dispatch.listReady(limit), kick: worker.kick })
  const service = createAgentChatService<C, I>({
    ...options.chat,
    active: (owner, session, runId) => dispatch.active(owner, session, runId),
    dispatch: {
      kick: worker.kick,
      notify: supervisor.notify,
      diagnose: () => options.supervisor.diagnose('worker_failed'),
      requestCancel: (owner, session) => dispatch.requestCancel(owner, session),
      retryReconstruction: dispatch.retryReconstruction?.bind(dispatch),
    },
  })
  let running: ReturnType<typeof supervisor.start> | undefined
  let closing: Promise<void> | undefined
  return {
    service,
    async start() {
      if (closing) await closing
      running ??= supervisor.start()
      const current = running
      try { await current } catch (error) {
        if (running === current) running = undefined
        throw error
      }
    },
    close() {
      if (closing) return closing
      if (!running) return Promise.resolve()
      closing = running.then(async current => {
        try { await current.stop() } finally { await current.drain() }
      }).finally(() => { running = undefined; closing = undefined })
      return closing
    },
  }
}

export interface AgentRuntimeContextFactoryOptions extends Omit<AgentRuntimeOptions, 'context'> {
  context: ProviderContextFactoryInput
}

/** 共享实际Provider实例的异步资源装配；旧同步入口保持原调用契约。 */
export async function createAgentRuntimeWithContextFactory(options: AgentRuntimeContextFactoryOptions) {
  const observation = options.observation ?? options.runtime.observation ?? options.provider.observation
  const connected = await connectProviderHarnessWithContextFactory(options.context, {
    ...options.provider, observation,
  })
  try {
    const harness = createCanonicalRunner({ context: connected.context, runPreparation: options.runPreparation,
      executor: options.executor, runtime: { ...options.runtime, observation, provider: connected.provider } })
    return { harness, close: () => connected.provider.close() }
  } catch (error) { await connected.provider.close(); throw error }
}
