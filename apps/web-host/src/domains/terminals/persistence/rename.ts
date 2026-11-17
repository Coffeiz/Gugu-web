import { createTerminalRenamer, type TerminalRenameRuntime } from '@gugu/core/terminals/rename'
import type { Pool } from 'pg'

export interface TerminalRenameHostRuntime extends Omit<TerminalRenameRuntime, 'sandboxReady' | 'sandboxUnavailableReason'> {
  readSandboxReadiness(): Promise<{ ready: boolean; reason?: string }>
}

/** Host supplies authenticated preferences, MXC readiness and the post-commit live resource publisher. */
export function createPostgresTerminalRenamer<DB>(
  pool: Pool,
  db: DB,
  runtime: TerminalRenameHostRuntime,
  publishChanged: (ownerId: string, terminalId: string, origin: string | null) => Promise<unknown>,
) {
  const rename = createTerminalRenamer(db as Parameters<typeof createTerminalRenamer>[0], 'postgres', publishChanged, { workspaceSupported: true })
  return async (ownerId: string, terminalId: string, input: { name: string; origin: string | null }) => {
    const [preference, readiness] = await Promise.all([
      pool.query<{ data_json: string | Record<string, unknown> } & Record<string, unknown>>(
        'SELECT data_json FROM user_preferences WHERE user_id = $1', [ownerId]),
      runtime.readSandboxReadiness(),
    ])
    return rename(ownerId, terminalId, {
      ...input,
      preferences: preference.rows[0]?.data_json,
      settings: { ...runtime, sandboxReady: readiness.ready, ...(readiness.reason ? { sandboxUnavailableReason: readiness.reason } : {}) },
    })
  }
}
