import type { Pool } from 'pg'
import { createPostgresAgentInteractionSession } from '@gugu/core/agent-sessions'

/** owner 与交互验证由 Core 处理；Host 管理 PG 连接池。 */
export function createInteractionSessionLookup(pool: Pool) {
  return { get: createPostgresAgentInteractionSession(pool) }
}
