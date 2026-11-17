import { sql, type Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { createDefaultWorkspaceShellTargetReader, createWorkspaceShellTargetReader } from '../workspaces/shell-target.js'

/** 每次命令均查询当前会话、工作区与未撤销授权，不缓存授权结果。 */
export function createTerminalShellFactsReader<DB>(db: Kysely<DB>, dialect: 'postgres' | 'sqlite') {
  const readTarget = createWorkspaceShellTargetReader(db, dialect)
  const readDefaultTarget = createDefaultWorkspaceShellTargetReader(db, dialect)
  return async (rawOwner: string, terminalId: string, filesystemAuthorizationEnabled: boolean) => {
    const canonical = dataContext(rawOwner).ownerId
    const owner = dialect === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    const terminal = (await sql<{ session_id: number | null; workspace_id: number | null; closed_at: string | null }>`SELECT session_id,workspace_id,closed_at FROM terminal_sessions WHERE id=${terminalId} AND owner_id=${owner}`.execute(db)).rows[0]
    if (!terminal || terminal.closed_at !== null) return null
    const session = terminal.session_id === null ? null : (await sql<{ workspace_id: number | null; filesystem_authorization_grant_id: number | null }>`SELECT workspace_id,filesystem_authorization_grant_id FROM conversation_sessions WHERE id=${terminal.session_id} AND user_id=${owner}`.execute(db)).rows[0]
    const workspaceId = session?.workspace_id ?? terminal.workspace_id
    // 未绑定 Workspace 仍会使用用户默认目录执行命令；把真实目标放入快照，
    // 以便确认等待期间默认目录变化时拒绝使用旧确认执行新目录。
    const target = workspaceId === null ? await readDefaultTarget(rawOwner) : await readTarget(rawOwner, workspaceId)
    const preference = (await sql<{ data_json: unknown }>`SELECT data_json FROM user_preferences WHERE user_id=${owner}`.execute(db)).rows[0]?.data_json
    let parsed: unknown = preference
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed) } catch { parsed = {} } }
    const prefs = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    const truthy = (value: unknown) => Array.isArray(value) ? value.length > 0 : value !== null && typeof value === 'object' ? Object.keys(value).length > 0 : Boolean(value)
    const grantIdFilter = session?.filesystem_authorization_grant_id == null ? sql`` : sql`AND id=${session.filesystem_authorization_grant_id}`
    const grant = !filesystemAuthorizationEnabled || !session || terminal.session_id === null ? null : (await sql`SELECT id FROM filesystem_authorization_grants WHERE user_id=${owner} AND subject_type='session' AND subject_id=${String(terminal.session_id)} AND scope='user_sandbox' AND permission='read_write' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP) ${grantIdFilter} LIMIT 1`.execute(db)).rows[0]
    return { sessionId: terminal.session_id, sessionOwned: terminal.session_id === null || !!session, workspaceValid: workspaceId === null || target !== null,
      workspaceId, workspaceTarget: target, userEnabled: truthy(prefs.shell_enabled ?? true), userDangerousEnabled: truthy(prefs.shell_dangerous_enabled ?? true), fullUserSandboxWrite: !!grant }
  }
}
