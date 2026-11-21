import { createLoopScopeTrace, defaultLoopScopeEndpoint, loopScopeTraceEnabled } from '@gugu/loopscope'
import type { AgentObservationPort } from '../agent/observation.js'
import { createNodeProviderTransport } from '../agent/providers/transport/node.js'

export function createDesktopLoopScope(env: Readonly<NodeJS.ProcessEnv>) {
  if (!loopScopeTraceEnabled(env.LOOPSCOPE_ENABLED)) return undefined

  const transport = createNodeProviderTransport({
    allowLocal: true, trustEnvironment: false, connectTimeoutMs: 5000, writeTimeoutMs: 10_000,
  })
  try {
    const trace = createLoopScopeTrace({
      endpoint: env.LOOPSCOPE_ENDPOINT?.trim() || defaultLoopScopeEndpoint,
      source: 'desktop',
      transport,
    })
    const observation: AgentObservationPort = { record: trace.record }
    return {
      observation,
      async close() {
        try { await trace.close() } finally { await transport.close() }
      },
    }
  } catch {
    // 开发采集配置无效时，桌面 Agent 仍可正常启动。
    void transport.close()
    return undefined
  }
}
