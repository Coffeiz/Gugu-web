import { createLoopScopeTrace, defaultLoopScopeEndpoint, loopScopeTraceEnabled } from '@gugu/loopscope'
import type { AgentObservation, AgentObservationPort } from '@gugu/core/agent'
import type { ProviderHttpRequest, ProviderTransport } from '@gugu/core/providers'

export interface WebLoopScopeTrace {
  observation: AgentObservationPort
  close(): Promise<void>
}

/** 仅在可信服务端配置明确开启时创建写入采集器。 */
export function createWebLoopScopeTrace(options: {
  enabled?: string
  endpoint?: string
  transport: ProviderTransport
}): WebLoopScopeTrace | undefined {
  if (!loopScopeTraceEnabled(options.enabled)) return undefined
  const collector = createLoopScopeTrace({
    endpoint: options.endpoint || defaultLoopScopeEndpoint,
    source: 'web',
    transport: {
      request: (request, signal) => options.transport.request(request as ProviderHttpRequest, signal),
    },
  })
  return {
    observation: { record: (event: AgentObservation) => collector.record(event as Parameters<typeof collector.record>[0]) },
    close: () => collector.close(),
  }
}
