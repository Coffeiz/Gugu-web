import { createTerminalDetailReader, type TerminalDetailRuntime } from '@gugu/core/terminals/detail'
import type { Pool } from 'pg'

type TerminalDetailHostRuntime = () => Promise<TerminalDetailRuntime>

/** PostgreSQL 偏好和隔离状态 are Host inputs; terminal data and authorization use cases stay in Core. */
export function createPostgresTerminalDetailReader<DB>(pool: Pool, db: DB, readRuntime: TerminalDetailHostRuntime) {
  const readDetail = createTerminalDetailReader(db as Parameters<typeof createTerminalDetailReader>[0], 'postgres', { workspaceSupported: true })
  return async (ownerId: string, terminalId: string) => {
    const [preference, settings] = await Promise.all([
      pool.query<{ data_json: string | Record<string, unknown> } & Record<string, unknown>>(
        'SELECT data_json FROM user_preferences WHERE user_id = $1', [ownerId]),
      readRuntime(),
    ])
    return readDetail(ownerId, terminalId, {
      preferences: preference.rows[0]?.data_json,
      settings,
    })
  }
}
