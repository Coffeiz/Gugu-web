import { createCanonicalRunner } from '@gugu/core/agent'
import type { CanonicalContextPorts, CanonicalRunContext, CanonicalRunPreparationPorts, HarnessExecutorPorts, AgentRunnerPorts } from '@gugu/core/agent'
import { connectProviderHarness } from '@gugu/core/providers'
import type { ProviderRuntimeOptions } from '@gugu/core/providers'
import { createNodeProviderTransportFactory } from '@gugu/core/providers/node'

/** 由 Host 注入可信来源、存储和授权；此处不创建伪持久化或不受限执行器。 */
export interface AgentRuntimeOptions {
  context: CanonicalContextPorts
  runPreparation?: CanonicalRunPreparationPorts
  executor: HarnessExecutorPorts
  runtime: Omit<AgentRunnerPorts<CanonicalRunContext>, 'context' | 'execution' | 'reply' | 'provider'>
  provider: Omit<ProviderRuntimeOptions, 'references' | 'prepareRequest' | 'digest' | 'nextId'>
}

/** 将同一组上下文端口交给 Provider 与 Harness，避免两套模型身份或历史。 */
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
