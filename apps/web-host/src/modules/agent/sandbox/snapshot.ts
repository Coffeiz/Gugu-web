import type { Pool } from 'pg'
import type { Kysely } from 'kysely'
import { createSessionWorkspaceTargetReader } from '@gugu/core/workspaces/shell-target'
import type { createTerminalRuntimeSettingsReader } from '../../terminals/settings.js'

export function createAgentShellSnapshotReader<DB>(
  pool: Pick<Pool, 'query'>,
  db: Kysely<DB>,
  settings: () => Promise<Omit<Awaited<ReturnType<ReturnType<typeof createTerminalRuntimeSettingsReader>>>, 'shellSystemEnabled'> & { shellSystemEnabled?: boolean }>,
  automaticModeGlobalEnabled = false,
) {
  const readWorkspace = createSessionWorkspaceTargetReader(db, 'postgres')
  return async (owner: string, session: string,
    diagnose?: (reason: 'invalid_session' | 'shell_disabled' | 'sandbox_unavailable' | 'workspace_unavailable' | 'account_unavailable') => void) => {
    const sessionId = Number(session)
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) { diagnose?.('invalid_session'); return null }
    const runtime = await settings()
    if (!runtime.shellEnabled) { diagnose?.('shell_disabled'); return null }
    if (!runtime.sandboxEnabled || !runtime.sandboxReady || runtime.networkProfile !== 'none') {
      diagnose?.('sandbox_unavailable'); return null
    }
    const target = await readWorkspace(owner, sessionId)
    if (!target) { diagnose?.('workspace_unavailable'); return null }
    const { rows: [row] } = await pool.query<{ preferences: unknown; full_write: boolean; security_version: number }>(`
      SELECT p.data_json AS preferences, u.security_version,
        EXISTS(SELECT 1 FROM filesystem_authorization_grants g
          WHERE $3 AND g.user_id=s.user_id AND g.subject_type='session'
            AND g.subject_id=s.id::text AND g.scope='user_sandbox' AND g.permission='read_write'
            AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>CURRENT_TIMESTAMP)) AS full_write
      FROM conversation_sessions s JOIN users u ON u.id=s.user_id
      LEFT JOIN user_preferences p ON p.user_id=s.user_id
      WHERE s.user_id=$1 AND s.id=$2 AND u.is_active=TRUE AND COALESCE(u.account_status,'active')='active'
    `, [owner, sessionId, runtime.filesystemAuthorizationEnabled])
    if (!row) { diagnose?.('account_unavailable'); return null }
    const raw = typeof row.preferences === 'string' ? JSON.parse(row.preferences) : row.preferences
    const prefs = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    return { workspaceId: target.workspaceId, workspaceTarget: JSON.stringify(target), securityVersion: row.security_version,
      isolatedWorkspace: target.kind === 'directory' ? `/workspace/${target.directoryName}` : undefined,
      automaticModeEnabled: automaticModeGlobalEnabled && prefs.automatic_mode_enabled === true,
      systemEnabled: runtime.shellSystemEnabled === true && (prefs.shell_system_enabled ?? false) === true, facts: {
      adminEnabled: runtime.shellEnabled, userEnabled: (prefs.shell_enabled ?? true) === true,
      sandboxEnabled: runtime.sandboxEnabled, sandboxReady: runtime.sandboxReady,
      sessionOwned: true, workspaceValid: true, filesystemAuthorizationAvailable: true,
      fullUserSandboxWrite: row.full_write, adminDangerousEnabled: runtime.shellDangerousEnabled,
      userDangerousEnabled: (prefs.shell_dangerous_enabled ?? true) === true,
    } }
  }
}
