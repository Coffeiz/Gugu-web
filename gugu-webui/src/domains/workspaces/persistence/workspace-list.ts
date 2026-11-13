import { CoreError, dataContext } from '@gugu/core'
import type { Pool } from 'pg'

export type WorkspaceListStorageBackend = 'local' | 'oss'
export type WorkspaceListTerminalMode = 'auto' | 'pty_disabled' | 'entry_disabled'

/** Host runtime facts that Python derives from application and sandbox settings. */
export interface WorkspaceListRuntimeSettings {
  storageBackend: WorkspaceListStorageBackend
  shellEnabled: boolean
  shellSystemEnabled: boolean
  shellDangerousEnabled: boolean
  automaticModeEnabled: boolean
  sandboxReady: boolean
  fullUserSandboxAuthorizationEnabled: boolean
  terminalMode: string
}

export interface WorkspaceListRuntime {
  /** Must use the same live sandbox readiness check as the Python API. */
  readRuntimeSettings(): WorkspaceListRuntimeSettings | Promise<WorkspaceListRuntimeSettings>
}

interface WorkspaceRow extends Record<string, unknown> {
  id: number
  name: string
  kind: 'folder' | 'project' | 'directory'
  folder_id: number | null
  project_id: number | null
  directory_id: number | null
  enabled: boolean
  is_default: boolean
}

interface CountRow extends Record<string, unknown> {
  workspace_id: number
  count: string
}

function validateOwner(ownerId: string): string {
  try {
    return dataContext(ownerId).ownerId
  } catch {
    throw new CoreError('invalid_request', '用户 ID 无效')
  }
}

function parsePreferences(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value || '{}')
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

// Match bool(value) for values loaded from Python's JSON-backed preferences.
function pythonTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false
  if (Array.isArray(value) || typeof value === 'string') return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

function normalizedTerminalMode(value: string): WorkspaceListTerminalMode {
  return value === 'pty_disabled' || value === 'entry_disabled' ? value : 'auto'
}

/** PostgreSQL read port for the management GET /api/v1/workspaces snapshot. */
export function createPostgresWorkspaceLister(pool: Pool, runtime: WorkspaceListRuntime) {
  return async function listWorkspaces(rawOwnerId: string): Promise<Record<string, unknown>> {
    const ownerId = validateOwner(rawOwnerId)
    const settings = await runtime.readRuntimeSettings()
    const terminalMode = normalizedTerminalMode(settings.terminalMode)
    const workspaceSupported = settings.storageBackend === 'local'

    const preferencesResult = await pool.query<{ data_json: string } & Record<string, unknown>>(
      'SELECT data_json FROM user_preferences WHERE user_id = $1',
      [ownerId],
    )
    const preferences = parsePreferences(preferencesResult.rows[0]?.data_json)
    const userEnabled = pythonTruthy(preferences.shell_enabled ?? true)
    const userSystemEnabled = pythonTruthy(preferences.shell_system_enabled ?? false)
    const userDangerousEnabled = pythonTruthy(preferences.shell_dangerous_enabled ?? true)
    const userAutomaticModeEnabled = pythonTruthy(preferences.automatic_mode_enabled ?? false)
    const shellAvailable = settings.shellEnabled && (
      userEnabled || (settings.shellSystemEnabled && userSystemEnabled)
    )
    const terminalEntryEnabled = settings.sandboxReady && terminalMode !== 'entry_disabled' && shellAvailable
    const ptyEnabled = settings.sandboxReady && terminalMode === 'auto' && shellAvailable

    let items: Array<Record<string, unknown>> = []
    if (workspaceSupported) {
      const rowsResult = await pool.query<WorkspaceRow>(
        `SELECT id, name, kind, folder_id, project_id, directory_id, enabled, is_default
         FROM workspaces WHERE user_id = $1 ORDER BY updated_at DESC`,
        [ownerId],
      )
      const countsResult = await pool.query<CountRow>(
        `SELECT workspace_id, COUNT(id)::text AS count FROM conversation_sessions
         WHERE user_id = $1 AND workspace_id IS NOT NULL GROUP BY workspace_id`,
        [ownerId],
      )
      const counts = new Map(countsResult.rows.map((row) => [Number(row.workspace_id), Number(row.count)]))
      items = rowsResult.rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        kind: row.kind,
        folderId: row.folder_id == null ? null : Number(row.folder_id),
        projectId: row.project_id == null ? null : Number(row.project_id),
        directoryId: row.directory_id == null ? null : Number(row.directory_id),
        enabled: row.enabled,
        isDefault: row.is_default,
        boundSessionCount: counts.get(Number(row.id)) ?? 0,
      }))
    }

    return {
      globalEnabled: Boolean(settings.shellEnabled),
      sandboxEnabled: Boolean(settings.sandboxReady),
      systemGlobalEnabled: Boolean(settings.shellSystemEnabled),
      dangerousGlobalEnabled: Boolean(settings.shellDangerousEnabled),
      automaticModeGlobalEnabled: Boolean(settings.automaticModeEnabled),
      userEnabled,
      userSystemEnabled,
      userDangerousEnabled,
      userAutomaticModeEnabled,
      filesystemAuthorizationEnabled: workspaceSupported && settings.fullUserSandboxAuthorizationEnabled,
      workspaceSupported,
      storageBackend: settings.storageBackend,
      terminalMode,
      terminalEntryEnabled,
      ptyEnabled,
      items,
    }
  }
}
