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
  type Runtime = Awaited<ReturnType<typeof settings>>
  const sandboxAvailable = (runtime: Runtime) =>
    runtime.sandboxEnabled && runtime.sandboxReady && runtime.networkProfile === 'none'
  function readPolicy(runtime: Runtime, preferences: unknown) {
    const raw = typeof preferences === 'string' ? JSON.parse(preferences) : preferences
    const prefs = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    return {
      automaticModeEnabled: automaticModeGlobalEnabled && prefs.automatic_mode_enabled === true,
      systemEnabled: runtime.shellSystemEnabled === true && prefs.shell_system_enabled === true,
      userEnabled: (prefs.shell_enabled ?? true) === true,
      userDangerousEnabled: (prefs.shell_dangerous_enabled ?? true) === true,
    }
  }
  const read = async (owner: string, session: string,
    diagnose?: (reason: 'invalid_session' | 'shell_disabled' | 'sandbox_unavailable' | 'workspace_unavailable' | 'account_unavailable') => void) => {
    const sessionId = Number(session)
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) { diagnose?.('invalid_session'); return null }
    const runtime = await settings()
    if (!runtime.shellEnabled) { diagnose?.('shell_disabled'); return null }
    if (!sandboxAvailable(runtime)) {
      diagnose?.('sandbox_unavailable'); return null
    }
    const { rows: [row] } = await pool.query<{ preferences: unknown; full_write: boolean; security_version: number; workspace_id: number | null }>(`
      SELECT p.data_json AS preferences, u.security_version, s.workspace_id,
        EXISTS(SELECT 1 FROM filesystem_authorization_grants g
          WHERE $3 AND g.user_id=s.user_id AND g.subject_type='session'
            AND g.subject_id=s.id::text AND g.scope='user_sandbox' AND g.permission='read_write'
            AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>CURRENT_TIMESTAMP)) AS full_write
      FROM conversation_sessions s JOIN users u ON u.id=s.user_id
      LEFT JOIN user_preferences p ON p.user_id=s.user_id
      WHERE s.user_id=$1 AND s.id=$2 AND u.is_active=TRUE AND COALESCE(u.account_status,'active')='active'
    `, [owner, sessionId, runtime.filesystemAuthorizationEnabled])
    if (!row) { diagnose?.('account_unavailable'); return null }
    const target = row.workspace_id === null ? null : await readWorkspace(owner, sessionId, { explicitOnly: true })
    if (row.workspace_id !== null && !target) { diagnose?.('workspace_unavailable'); return null }
    const policy = readPolicy(runtime, row.preferences)
    return { workspaceId: target?.workspaceId ?? null, workspaceTarget: JSON.stringify(target ?? { kind: 'personal' }), securityVersion: row.security_version,
      isolatedWorkspace: target?.kind === 'directory' ? `/workspace/${target.directoryName}` : undefined,
      automaticModeEnabled: policy.automaticModeEnabled,
      systemEnabled: policy.systemEnabled, facts: {
      adminEnabled: runtime.shellEnabled, userEnabled: policy.userEnabled,
      sandboxEnabled: runtime.sandboxEnabled, sandboxReady: runtime.sandboxReady,
      sessionOwned: true, workspaceValid: true, filesystemAuthorizationAvailable: true,
      fullUserSandboxWrite: row.full_write, adminDangerousEnabled: runtime.shellDangerousEnabled,
      userDangerousEnabled: policy.userDangerousEnabled,
    } }
  }
  return Object.assign(read, {
    async readScheduledShellPolicy(owner: string) {
      const runtime = await settings()
      if (!runtime.shellEnabled) return null
      const { rows: [row] } = await pool.query<{ preferences: unknown }>(`
        SELECT p.data_json AS preferences
        FROM users u LEFT JOIN user_preferences p ON p.user_id=u.id
        WHERE u.id=$1 AND u.is_active=TRUE AND COALESCE(u.account_status,'active')='active'
      `, [owner])
      if (!row) return null
      const policy = readPolicy(runtime, row.preferences)
      if (!policy.userEnabled) return null
      return { systemEnabled: policy.systemEnabled }
    },
    async allowsReferenceRead(owner: string) {
      return (await settings()).shellEnabled && await ownerAllowsShell(owner)
    },
  })
  async function ownerAllowsShell(owner: string) {
    const { rows: [row] } = await pool.query<{ enabled: boolean }>(`
        SELECT COALESCE(NULLIF(p.data_json::jsonb -> 'shell_enabled', 'null'::jsonb), 'true'::jsonb) = 'true'::jsonb AS enabled
        FROM users u LEFT JOIN user_preferences p ON p.user_id=u.id
        WHERE u.id=$1 AND u.is_active=TRUE AND COALESCE(u.account_status,'active')='active'
      `, [owner])
    return row?.enabled === true
  }
}
