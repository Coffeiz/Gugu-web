import { CoreError } from '../../../../../packages/core/src/contracts/index.js'
import type { WorkspaceAgentReadPort } from '../../../../../packages/core/src/workspaces/workspace-list.js'

type HostRequest = (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
type WorkspaceDirectory = { id: string; name: string }

const desktopWorkspaceId = /^desktop:[0-9a-f-]{36}$/u

function directories(value: unknown): WorkspaceDirectory[] {
  if (!Array.isArray(value)) throw new CoreError('storage_error', '桌面工作区列表无效')
  return value.flatMap(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      throw new CoreError('storage_error', '桌面工作区记录无效')
    const item = row as Record<string, unknown>
    if (item.id === 'personal') return []
    if (typeof item.id !== 'string' || !desktopWorkspaceId.test(item.id)
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100)
      throw new CoreError('storage_error', '桌面工作区记录无效')
    return [{ id: item.id, name: item.name }]
  })
}

/** 桌面工作区来自文件目录登记，不查询 Web 的 workspaces SQL 表。 */
export function createDesktopWorkspaceReadPort(hostRequest: HostRequest): WorkspaceAgentReadPort {
  return { async read(_ownerId, workspaceId, signal) {
    signal?.throwIfAborted()
    const rows = directories(await hostRequest('agent.files.workspaceList', {}, signal))
    signal?.throwIfAborted()
    const selected = workspaceId === undefined ? rows
      : typeof workspaceId === 'string' ? rows.filter(row => row.id === workspaceId) : []
    return selected.map(row => ({
      workspace_id: row.id,
      name: row.name,
      kind: 'directory',
      project_id: null,
      folder_id: null,
      directory_id: row.id,
      directory_name: row.name,
    }))
  } }
}
