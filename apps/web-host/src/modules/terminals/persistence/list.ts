import { createTerminalListReader, type TerminalListRuntime } from '@gugu/core/terminals/list'
import type { Pool } from 'pg'

type TerminalListHostRuntime = () => Promise<TerminalListRuntime>

/** PostgreSQL preference lookup and 隔离就绪状态 stay in Web Host; list rules and cleanup stay in Core. */
export function createPostgresTerminalListReader<DB>(pool: Pool, db: DB, readRuntime: TerminalListHostRuntime) {
  // Gugu 2.0 Web Host rejects non-local storage backends during config loading, matching Python's workspace_shell_supported().
  const readList = createTerminalListReader(db as Parameters<typeof createTerminalListReader>[0], 'postgres', { workspaceSupported: true })
  return async (ownerId: string) => {
    const [preference, settings] = await Promise.all([
      pool.query<{ data_json: string | Record<string, unknown> } & Record<string, unknown>>(
        'SELECT data_json FROM user_preferences WHERE user_id = $1', [ownerId]),
      readRuntime(),
    ])
    return readList(ownerId, {
      preferences: preference.rows[0]?.data_json,
      settings,
    })
  }
}
