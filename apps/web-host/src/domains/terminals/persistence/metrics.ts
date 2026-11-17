import { terminalPageAccess, createTerminalMetricsReader, type TerminalPageAccessSettings } from '@gugu/core/terminals/metrics'
import type { Pool } from 'pg'

export interface TerminalMetricsRuntime extends Omit<TerminalPageAccessSettings, 'sandboxReady' | 'sandboxUnavailableReason'> {
  readSandboxReadiness(): Promise<{ ready: boolean; reason?: string }>
}

/** Web Host 注入 PostgreSQL preferences 与 MXC readiness，规则和聚合留在 Core。 */
export function createPostgresTerminalMetricsReader<DB>(pool: Pool, db: DB, runtime: TerminalMetricsRuntime) {
  const readMetrics = createTerminalMetricsReader(db as Parameters<typeof createTerminalMetricsReader>[0])
  return async (ownerId: string) => {
    const [preference, readiness] = await Promise.all([
      pool.query<{ data_json: string | Record<string, unknown> } & Record<string, unknown>>(
        'SELECT data_json FROM user_preferences WHERE user_id = $1', [ownerId]),
      runtime.readSandboxReadiness(),
    ])
    const allowed = terminalPageAccess(preference.rows[0]?.data_json, {
      sandboxReady: readiness.ready,
      sandboxUnavailableReason: readiness.reason,
      terminalMode: runtime.terminalMode,
      shellEnabled: runtime.shellEnabled,
      shellSystemEnabled: runtime.shellSystemEnabled,
    })
    if (!allowed.allowed) throw Object.assign(new Error(allowed.reason), { statusCode: 403 })
    return readMetrics(ownerId)
  }
}
