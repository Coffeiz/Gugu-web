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
      async resolveSessionMetadata(sessionId) {
        const id = Number(sessionId)
        if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== sessionId) return undefined
        const owner = ownerId.replaceAll('-', '')
        const result = await sql<{ title: string | null; platform: string | null }>`
          SELECT s.title, im.platform FROM conversation_sessions s
          LEFT JOIN desktop_im_sessions im ON im.session_id = s.id AND im.owner_id = s.user_id
          WHERE s.id = ${id} AND s.user_id = ${owner}
        `.execute(db)
        const session = result.rows[0]
        if (!session) return undefined
        const platform = session.platform
        return { title: session.title?.trim() || undefined,
          imPlatform: platform && ['feishu', 'qq', 'wechat', 'telegram'].includes(platform) ? platform : undefined }
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
