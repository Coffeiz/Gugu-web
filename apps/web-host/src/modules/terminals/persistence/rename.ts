import { createTerminalRenamer, type TerminalRenameRuntime } from '@gugu/core/terminals/rename'
import type { Pool } from 'pg'

type TerminalRenameHostRuntime = () => Promise<TerminalRenameRuntime>

/** Host supplies authenticated preferences, 隔离就绪状态 and the post-commit live resource publisher. */
export function createPostgresTerminalRenamer<DB>(
  pool: Pool,
  db: DB,
  readRuntime: TerminalRenameHostRuntime,
  publishChanged: (ownerId: string, terminalId: string, origin: string | null) => Promise<unknown>,
) {
  const rename = createTerminalRenamer(db as Parameters<typeof createTerminalRenamer>[0], 'postgres', publishChanged, { workspaceSupported: true })
  return async (ownerId: string, terminalId: string, input: { name: string; origin: string | null }) => {
    const [preference, settings] = await Promise.all([
      pool.query<{ data_json: string | Record<string, unknown> } & Record<string, unknown>>(
        'SELECT data_json FROM user_preferences WHERE user_id = $1', [ownerId]),
      readRuntime(),
    ])
    return rename(ownerId, terminalId, {
      ...input,
      preferences: preference.rows[0]?.data_json,
      settings,
    })
  }
}
