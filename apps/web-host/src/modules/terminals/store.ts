import { createTerminalListReader, type TerminalListRuntime } from '@gugu/core/terminals/list'
import type { Pool } from 'pg'
import { createTerminalDetailReader, type TerminalDetailRuntime } from '@gugu/core/terminals/detail'
import { createTerminalEventPageReader } from '@gugu/core/terminals/events'
import { terminalPageAccess, createTerminalMetricsReader, type TerminalPageAccessSettings } from '@gugu/core/terminals/metrics'
import { createTerminalRenamer, type TerminalRenameRuntime } from '@gugu/core/terminals/rename'

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

/** Reuses the detail authorization path, then reads owner-scoped persisted event pages from Core. */
export function createPostgresTerminalEventStream<DB>(pool: Pool, db: DB, runtime: Parameters<typeof createPostgresTerminalDetailReader>[2]) {
  const readDetail = createPostgresTerminalDetailReader(pool, db, runtime)
  const readPage = createTerminalEventPageReader(db as Parameters<typeof createTerminalEventPageReader>[0], 'postgres')
  return {
    async authorize(ownerId: string, terminalId: string): Promise<void> { await readDetail(ownerId, terminalId) },
    readPage,
  }
}

type TerminalMetricsRuntime = () => Promise<TerminalPageAccessSettings>

/** Web Host 注入 PostgreSQL preferences 与 隔离就绪状态，规则和聚合留在 Core。 */
export function createPostgresTerminalMetricsReader<DB>(pool: Pool, db: DB, readRuntime: TerminalMetricsRuntime) {
  const readMetrics = createTerminalMetricsReader(db as Parameters<typeof createTerminalMetricsReader>[0])
  return async (ownerId: string) => {
    const [preference, settings] = await Promise.all([
      pool.query<{ data_json: string | Record<string, unknown> } & Record<string, unknown>>(
        'SELECT data_json FROM user_preferences WHERE user_id = $1', [ownerId]),
      readRuntime(),
    ])
    const allowed = terminalPageAccess(preference.rows[0]?.data_json, settings)
    if (!allowed.allowed) throw Object.assign(new Error(allowed.reason), { statusCode: 403 })
    return readMetrics(ownerId)
  }
}

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
