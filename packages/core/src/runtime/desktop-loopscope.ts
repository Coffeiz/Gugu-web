import { createLoopScopeTrace, defaultLoopScopeEndpoint, loopScopeTraceEnabled } from '@gugu/loopscope'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../data/schema.js'
import type { AgentObservationPort } from '../agent/observation.js'
import { createNodeProviderTransport } from '../agent/providers/transport/node.js'

export function createDesktopLoopScope(env: Readonly<NodeJS.ProcessEnv>, db: Kysely<Database>, ownerId: string) {
  if (!loopScopeTraceEnabled(env.LOOPSCOPE_ENABLED)) return undefined

  const transport = createNodeProviderTransport({
    allowLocal: true, trustEnvironment: false, connectTimeoutMs: 5000, writeTimeoutMs: 10_000,
  })
  try {
    const trace = createLoopScopeTrace({
      endpoint: env.LOOPSCOPE_ENDPOINT?.trim() || defaultLoopScopeEndpoint,
      source: 'desktop',
      async resolveSessionTitle(sessionId) {
        const id = Number(sessionId)
        if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== sessionId) return undefined
        const owner = ownerId.replaceAll('-', '')
        const result = await sql<{ title: string | null }>`
          SELECT title FROM conversation_sessions WHERE id = ${id} AND user_id = ${owner}
        `.execute(db)
        return result.rows[0]?.title?.trim() || undefined
      },
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
