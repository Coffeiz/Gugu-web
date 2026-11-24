import { CoreError, dataContext } from '../contracts/index.js'

export type WorkspaceListTerminalMode = 'auto' | 'pty_disabled' | 'entry_disabled'
export interface WorkspaceListRuntimeSettings {
  shellEnabled: boolean
  shellSystemEnabled: boolean
  shellDangerousEnabled: boolean
  automaticModeEnabled: boolean
  sandboxReady: boolean
  fullUserSandboxAuthorizationEnabled: boolean
  terminalMode: string
}
export interface WorkspaceListRuntime {
  readRuntimeSettings(signal?: AbortSignal): WorkspaceListRuntimeSettings | Promise<WorkspaceListRuntimeSettings>
}
export interface WorkspaceListRow {
  id: number
  name: string
  kind: 'project' | 'directory'
  project_id: number | null
  directory_id: number | null
  enabled: boolean
  is_default: boolean
}
export interface WorkspaceListReadPort {
  preferences(ownerId: string, signal?: AbortSignal): Promise<string | null | undefined>
  /** owner内全部声明，含停用项；保留管理API原有updated_at倒序。 */
  workspaces(ownerId: string, signal?: AbortSignal): Promise<readonly WorkspaceListRow[]>
  boundSessionCounts(ownerId: string, signal?: AbortSignal): Promise<readonly { workspace_id: number; count: number | string }[]>
}

function preferences(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value || '{}')
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} } // 与Python历史JSON偏好损坏时的默认行为一致。
}
function pythonTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false
  if (Array.isArray(value) || typeof value === 'string') return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

/** 工作区管理列表的公共用例；运行事实由可信Host提供，不授予实际Shell权限。 */
export function createWorkspaceLister(store: WorkspaceListReadPort, runtime: WorkspaceListRuntime) {
  return async (rawOwnerId: string, options: { readonly signal?: AbortSignal } = {}): Promise<Record<string, unknown>> => {
    const signal = options.signal
    signal?.throwIfAborted()
    try {
      let ownerId: string
      try { ownerId = dataContext(rawOwnerId).ownerId }
      catch { throw new CoreError('invalid_request', '用户 ID 无效') }
      const settings = await runtime.readRuntimeSettings(signal)
      signal?.throwIfAborted()
      const terminalMode: WorkspaceListTerminalMode = settings.terminalMode === 'pty_disabled' || settings.terminalMode === 'entry_disabled' ? settings.terminalMode : 'auto'
      const prefs = preferences(await store.preferences(ownerId, signal))
      signal?.throwIfAborted()
      const userEnabled = pythonTruthy(prefs.shell_enabled ?? true)
      const userSystemEnabled = pythonTruthy(prefs.shell_system_enabled ?? false)
      const userDangerousEnabled = pythonTruthy(prefs.shell_dangerous_enabled ?? true)
      const userAutomaticModeEnabled = pythonTruthy(prefs.automatic_mode_enabled ?? false)
      const shellAvailable = settings.shellEnabled && (userEnabled || (settings.shellSystemEnabled && userSystemEnabled))
      const rows = await store.workspaces(ownerId, signal)
      signal?.throwIfAborted()
      const counts = new Map((await store.boundSessionCounts(ownerId, signal)).map(row => [Number(row.workspace_id), Number(row.count)]))
      return {
        globalEnabled: Boolean(settings.shellEnabled), sandboxEnabled: Boolean(settings.sandboxReady),
        systemGlobalEnabled: Boolean(settings.shellSystemEnabled), dangerousGlobalEnabled: Boolean(settings.shellDangerousEnabled),
        automaticModeGlobalEnabled: Boolean(settings.automaticModeEnabled),
        userEnabled, userSystemEnabled, userDangerousEnabled, userAutomaticModeEnabled,
        filesystemAuthorizationEnabled: settings.fullUserSandboxAuthorizationEnabled,
        workspaceSupported: true, storageBackend: 'local', terminalMode,
        terminalEntryEnabled: settings.sandboxReady && terminalMode !== 'entry_disabled' && shellAvailable,
        ptyEnabled: settings.sandboxReady && terminalMode === 'auto' && shellAvailable && settings.fullUserSandboxAuthorizationEnabled,
        items: rows.map(row => ({ id: Number(row.id), name: row.name, kind: row.kind,
          projectId: row.project_id == null ? null : Number(row.project_id),
          directoryId: row.directory_id == null ? null : Number(row.directory_id), enabled: row.enabled, isDefault: row.is_default,
          boundSessionCount: counts.get(Number(row.id)) ?? 0,
        })),
      }
    } finally { signal?.throwIfAborted() }
  }
}

export interface AgentWorkspacePayload {
  workspace_id: number | string; name: string; kind: string; enabled?: boolean; is_default?: boolean; bound_session_count?: number
  project_id: number | null; project_name?: string | null
  directory_id?: number | string; directory_name?: string | null
  available?: boolean; location?: import('../agent/sessions/reference-context.js').ResolvedObjectPath
}
export interface WorkspaceAgentReadPort {
  read(ownerId: string, workspaceId: number | string | undefined, signal?: AbortSignal): Promise<AgentWorkspacePayload[]>
}

/** Agent管理视图保留停用声明及关联资源名称，不授予Shell或文件系统权限。 */
export function createAgentWorkspaceQueries(port: WorkspaceAgentReadPort) {
  return {
    async list(rawOwner: string, signal?: AbortSignal) {
      signal?.throwIfAborted()
      return port.read(dataContext(rawOwner).ownerId, undefined, signal).finally(() => signal?.throwIfAborted())
    },
    async get(rawOwner: string, workspaceId: number | string, signal?: AbortSignal) {
      signal?.throwIfAborted()
      if (typeof workspaceId === 'number' ? !Number.isSafeInteger(workspaceId) || workspaceId < 1
        : typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 256)
        throw new CoreError('invalid_request', '工作区ID无效')
      const rows = await port.read(dataContext(rawOwner).ownerId, workspaceId, signal).finally(() => signal?.throwIfAborted())
      return rows[0] ?? null
    },
  }
}
