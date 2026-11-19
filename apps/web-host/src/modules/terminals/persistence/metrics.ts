import { terminalPageAccess, createTerminalMetricsReader, type TerminalPageAccessSettings } from '@gugu/core/terminals/metrics'
import type { Pool } from 'pg'

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
