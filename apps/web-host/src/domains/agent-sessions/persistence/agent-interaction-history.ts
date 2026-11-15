import { createPostgresAgentInteractionHistory as createCoreHistory } from '@gugu/core/agent-sessions'
import type { AgentInteractionHistoryWindow } from '@gugu/core/agent-sessions'
import type { Pool } from 'pg'

export type { AgentInteractionHistoryWindow }

/** 连接池生命周期由 Host 管理。 */
export function createPostgresAgentInteractionHistory(pool: Pool, now: () => Date = () => new Date()) {
  return { list: createCoreHistory(pool, now) }
}
