import { createCanonicalRunner } from './runner.js'
import type { CanonicalRunContext } from './models.js'
import type { CanonicalContextPorts, CanonicalRunPreparationPorts, AgentRunnerPorts } from './ports.js'
import type { HarnessExecutorPorts } from './executor/contracts.js'
import { connectProviderHarness } from './providers/runtime.js'
import type { ProviderRuntimeOptions } from './providers/runtime.js'
import { createNodeProviderTransportFactory } from './providers/transport/node.js'

/** Agent Harness 的可移植组合入口；可信身份、存储、授权和执行能力由 Host 注入。 */
export interface AgentRuntimeOptions {
  context: CanonicalContextPorts
  runPreparation?: CanonicalRunPreparationPorts
  executor: HarnessExecutorPorts
  runtime: Omit<AgentRunnerPorts<CanonicalRunContext>, 'context' | 'execution' | 'reply' | 'provider'>
  provider: Omit<ProviderRuntimeOptions, 'references' | 'prepareRequest' | 'digest' | 'nextId'>
}

/** 同一组上下文端口同时供 Provider 与 Harness 使用，避免模型身份或历史分叉。 */
export function createAgentRuntime(options: AgentRuntimeOptions) {
  const connected = connectProviderHarness(options.context, {
    ...options.provider,
    ...(!options.provider.transport && !options.provider.createTransport && !options.provider.transportFactory
      ? { transportFactory: createNodeProviderTransportFactory() } : {}),
  })
  const harness = createCanonicalRunner({
    context: connected.context,
    runPreparation: options.runPreparation,
    executor: options.executor,
    runtime: { ...options.runtime, provider: connected.provider },
  })
  return { harness, close: () => connected.provider.close() }
}
