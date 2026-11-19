import { createLoopScopeTrace, defaultLoopScopeEndpoint, loopScopeTraceEnabled } from '@gugu/loopscope'
import type { AgentObservation, AgentObservationPort } from '@gugu/core/agent'
import type { ProviderHttpRequest, ProviderTransport } from '@gugu/core/providers'

export interface WebLoopScopeTrace {
  observation: AgentObservationPort
  forSource(source: 'web' | 'im' | 'scheduled'): AgentObservationPort
  close(): Promise<void>
}

/** 仅在可信服务端配置明确开启时创建写入采集器。 */
export function createWebLoopScopeTrace(options: {
  enabled?: string
  endpoint?: string
  transport: ProviderTransport
}): WebLoopScopeTrace | undefined {
  if (!loopScopeTraceEnabled(options.enabled)) return undefined
  const collectors = new Map<string, ReturnType<typeof createLoopScopeTrace>>()
  const collectorFor = (source: 'web' | 'im' | 'scheduled') => {
    let collector = collectors.get(source)
    if (!collector) {
      collector = createLoopScopeTrace({
        endpoint: options.endpoint || defaultLoopScopeEndpoint,
        source,
        transport: {
          request: (request, signal) => options.transport.request(request as ProviderHttpRequest, signal),
        },
      })
      collectors.set(source, collector)
    }
    return collector
  }
  const portFor = (source: 'web' | 'im' | 'scheduled'): AgentObservationPort => {
    const collector = collectorFor(source)
    return { record: (event: AgentObservation) => collector.record(event as Parameters<typeof collector.record>[0]) }
  }
  const observation = portFor('web')
  return {
    observation,
    forSource: portFor,
    async close() { await Promise.all([...collectors.values()].map(collector => collector.close())) },
  }
}
