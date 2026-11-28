import { sql, type Kysely } from 'kysely'
import { CoreError, dataContext } from '../contracts/index.js'

export interface TerminalPageAccessSettings {
  sandboxReady: boolean
  sandboxUnavailableReason?: string
  terminalMode: 'auto' | 'pty_disabled' | 'entry_disabled' | string
  shellEnabled: boolean
  shellSystemEnabled: boolean
}

function preferenceObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return {} }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function pythonTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false
  if (Array.isArray(value) || typeof value === 'string') return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

/** Python terminals.page_access 的共享策略；运行时隔离能力由可信 Host 探测并传入。 */
export function terminalPageAccess(rawPreferences: unknown, settings: TerminalPageAccessSettings) {
  if (!settings.sandboxReady) return { allowed: false, reason: settings.sandboxUnavailableReason || 'MXC 隔离沙盒不可用' }
  if (settings.terminalMode === 'entry_disabled') return { allowed: false, reason: '终端入口已由管理员关闭' }
  if (!settings.shellEnabled) return { allowed: false, reason: '管理员未开启 Shell 工具' }
  const prefs = preferenceObject(rawPreferences)
  const userEnabled = pythonTruthy(prefs.shell_enabled ?? true)
  const userSystemEnabled = pythonTruthy(prefs.shell_system_enabled ?? false)
  if (userEnabled || (settings.shellSystemEnabled && userSystemEnabled)) return { allowed: true, reason: '允许访问终端' }
  return { allowed: false, reason: '用户未开启 Shell' }
}

/** 跨 PG/SQLite 复用 owner 计数与 Python DTO；运行状态按持久化视图返回。 */
export function createTerminalMetricsReader<DB>(db: Kysely<DB>) {
  return async (rawOwnerId: string) => {
    let ownerId: string
    try { ownerId = dataContext(rawOwnerId).ownerId }
    catch { throw new CoreError('invalid_request', '用户 ID 无效') }
    const row = (await sql<{ total: number | string; running: number | string; output_chars: number | string | null }>`
      SELECT COUNT(*) AS total,
        COUNT(CASE WHEN status = 'running' AND closed_at IS NULL THEN 1 END) AS running,
        COALESCE(SUM(output_chars), 0) AS output_chars
      FROM terminal_sessions WHERE owner_id = ${ownerId}
    `.execute(db)).rows[0]
    return {
      total: Number(row?.total ?? 0),
      running: Number(row?.running ?? 0),
      outputChars: Number(row?.output_chars ?? 0),
      retentionDays: 30,
      outputRetentionChars: 500_000,
    }
  }
}
