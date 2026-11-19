import type { Pool } from 'pg'
import type { Kysely } from 'kysely'
import { createTerminalReopener, type TerminalReopenSettings } from '@gugu/core/terminals/reopen'
import type { TerminalListItem } from '@gugu/core/terminals/list'
import type { RedisEventPublisher } from '../../adapters/redis-events.js'

/** Host preferences and live MXC readiness feed the Core owner transaction. */
export function createPostgresTerminalReopener<DB>(options: {
  pool: Pool
  db: Kysely<DB>
  publisher: Pick<RedisEventPublisher, 'publishResourceChanged'>
  readRuntime(): Promise<TerminalReopenSettings>
  now?: () => Date
}) {
  const reopen = createTerminalReopener(options.db, 'postgres', async (ownerId, terminalId, origin) => {
    await options.publisher.publishResourceChanged({ ownerId, resource: 'terminals', operation: 'update', entityId: terminalId, origin })
  }, { workspaceSupported: true, ...(options.now ? { now: options.now } : {}) })

  return async (ownerId: string, terminalId: string, origin: string | null): Promise<TerminalListItem> => {
    const [preferences, settings] = await Promise.all([
      options.pool.query<{ data_json: string | Record<string, unknown> } & Record<string, unknown>>(
        'SELECT data_json FROM user_preferences WHERE user_id=$1', [ownerId]),
      options.readRuntime(),
    ])
    return reopen(ownerId, terminalId, {
      preferences: preferences.rows[0]?.data_json,
      settings,
      ptyEnabled: settings.terminalMode === 'auto' && settings.fullUserSandboxAuthorizationEnabled,
      origin,
    })
  }
}
