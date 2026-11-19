import type { Pool } from 'pg'
import type { Kysely } from 'kysely'
import { createTerminalCreator, type TerminalCreateAccessSettings } from '@gugu/core/terminals/create'
import type { TerminalListItem } from '@gugu/core/terminals/list'
import type { RedisEventPublisher } from '../../adapters/redis-events.js'

/** Host-only preferences/readiness are combined with the Core creation transaction. */
export function createPostgresTerminalCreator<DB>(options: {
  pool: Pool
  db: Kysely<DB>
  publisher: Pick<RedisEventPublisher, 'publishResourceChanged'>
  readRuntime(): Promise<TerminalCreateAccessSettings>
  now?: () => Date
}) {
  const create = createTerminalCreator(options.db, 'postgres', async (ownerId, terminalId, origin) => {
    await options.publisher.publishResourceChanged({ ownerId, resource: 'terminals', operation: 'create', entityId: terminalId, origin })
  }, { workspaceSupported: true, ...(options.now ? { now: options.now } : {}) })

  return async (ownerId: string, input: {
    name: string
    sessionId: number | null
    workspaceId: number | null
    mode: 'agent-events' | 'interactive-pty'
    origin: string | null
  }): Promise<TerminalListItem> => {
    const [preferences, settings] = await Promise.all([
      options.pool.query<{ data_json: string | Record<string, unknown> } & Record<string, unknown>>(
        'SELECT data_json FROM user_preferences WHERE user_id=$1', [ownerId]),
      options.readRuntime(),
    ])
    return create(ownerId, {
      ...input,
      preferences: preferences.rows[0]?.data_json,
      settings,
      ptyEnabled: settings.terminalMode === 'auto' && settings.fullUserSandboxAuthorizationEnabled,
    })
  }
}
