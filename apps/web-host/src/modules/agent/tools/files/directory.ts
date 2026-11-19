import type { RunIdentity } from '@gugu/core/agent'
import type { FileDirectoryPort } from '@gugu/core/tools'
import type { AgentDispatchLease } from '../../run/dispatch.js'
import type { FileBrowserOperations } from '../../../files/browse.js'
import type { Pool, QueryResultRow } from 'pg'

type IdRow = QueryResultRow & { id: number | string }

async function resolveFileLibraryDirectory(pool: Pick<Pool, 'query'>, ownerId: string, filePath: string, signal: AbortSignal) {
  const parts = filePath.split('/').slice(1)
  const area = parts.shift() as 'personal' | 'project' | 'workspace' | undefined
  if (!area || !['personal', 'project', 'workspace'].includes(area)) throw new Error('文件库登记路径无效')
  let projectId: number | null = null
  let workspaceDirectoryId: number | null = null
  if (area === 'project' || area === 'workspace') {
    const name = parts.shift()
    if (!name) throw new Error('文件库登记路径缺少项目或工作区名称')
    signal.throwIfAborted()
    const result = area === 'project'
      ? await pool.query<IdRow>('SELECT id FROM projects WHERE user_id=$1 AND name=$2 AND deleted_at IS NULL ORDER BY id LIMIT 2', [ownerId, name])
      : await pool.query<IdRow>('SELECT id FROM workspace_directories WHERE user_id=$1 AND directory_name=$2 AND deleted_at IS NULL ORDER BY id LIMIT 2', [ownerId, name])
    signal.throwIfAborted()
    if (result.rows.length !== 1) throw new Error('文件库登记路径不存在或名称不唯一')
    if (area === 'project') projectId = Number(result.rows[0]!.id)
    else workspaceDirectoryId = Number(result.rows[0]!.id)
  }

  let folderId: number | null = null
  for (const name of parts) {
    signal.throwIfAborted()
    const folderResult: { rows: IdRow[] } = await pool.query<IdRow>(`SELECT id FROM folders
      WHERE user_id=$1 AND deleted_at IS NULL AND name=$2 AND parent_id IS NOT DISTINCT FROM $3
        AND project_id IS NOT DISTINCT FROM $4 AND workspace_directory_id IS NOT DISTINCT FROM $5
      ORDER BY id LIMIT 2`, [ownerId, name, folderId, projectId, workspaceDirectoryId])
    signal.throwIfAborted()
    if (folderResult.rows.length !== 1) throw new Error('文件库登记路径不存在或名称不唯一')
    folderId = Number(folderResult.rows[0]!.id)
  }
  return { space: area, ...(projectId !== null ? { project_id: projectId } : {}),
    ...(workspaceDirectoryId !== null ? { workspace_directory_id: workspaceDirectoryId } : {}),
    ...(folderId !== null ? { folder_id: folderId } : {}) } as const
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function page(value: unknown): { items: Record<string, unknown>[]; has_more: boolean; next_cursor: string | null; total?: number } {
  const raw = object(value)
  if (!raw || !Array.isArray(raw.items) || typeof raw.has_more !== 'boolean'
    || (raw.next_cursor !== null && typeof raw.next_cursor !== 'string')
    || (raw.total !== undefined && (!Number.isSafeInteger(raw.total) || Number(raw.total) < 0))) throw new Error('文件目录服务返回无效结果')
  const items = raw.items.map(object)
  if (items.some(item => !item)) throw new Error('文件目录服务返回无效结果')
  return { items: items as Record<string, unknown>[], has_more: raw.has_more, next_cursor: raw.next_cursor,
    ...(raw.total !== undefined ? { total: Number(raw.total) } : {}) }
}

/** Agent 目录读取复用 Web 文件浏览域服务，身份只从本次 dispatch lease 获取。 */
export function createWebAgentFileDirectoryPort(
  operations: FileBrowserOperations,
  lease: AgentDispatchLease,
  pool?: Pick<Pool, 'query'>,
): FileDirectoryPort {
  const expected = Object.freeze({ ...lease.identity })
  return {
    async list(identity: RunIdentity, query, signal) {
      signal.throwIfAborted()
      if (identity.ownerId !== expected.ownerId || identity.sessionId !== expected.sessionId || identity.runId !== expected.runId)
        throw new Error('目录读取授权已失效')
      const location = query.file_path
        ? pool ? await resolveFileLibraryDirectory(pool, expected.ownerId, query.file_path, signal)
          : (() => { throw new Error('文件库登记路径解析能力未装配') })()
        : { space: query.space!, ...(query.project_id !== undefined ? { project_id: query.project_id } : {}),
          ...(query.workspace_directory_id !== undefined ? { workspace_directory_id: query.workspace_directory_id } : {}),
          ...(query.mind_map_id !== undefined ? { mind_map_id: query.mind_map_id } : {}),
          ...(query.folder_id !== undefined ? { folder_id: query.folder_id } : {}) }
      const filesPromise = query.kind === 'folder' ? Promise.resolve({ items: [], has_more: false, next_cursor: null })
        : operations.listFiles(expected.ownerId, {
          limit: query.limit, cursor: query.file_cursor ?? null, sortBy: query.sort_by, sortOrder: query.sort_order,
          space: location.space, projectId: location.project_id ?? null, folderId: location.folder_id ?? null,
          workspaceDirectoryId: location.workspace_directory_id ?? null, mindMapId: query.mind_map_id ?? null,
          ext: query.ext ?? null, q: query.q ?? null,
          ...(query.queries ? { queries: query.queries } : {}), ...(query.mode ? { mode: query.mode } : {}),
        })
      const foldersPromise = query.kind === 'file' || location.space === 'mind' || location.space === 'asset'
        ? Promise.resolve({ items: [], has_more: false, next_cursor: null })
        : operations.listFolders(expected.ownerId, {
          limit: query.limit, cursor: query.folder_cursor ?? null, sortBy: query.sort_by, sortOrder: query.sort_order,
          projectId: location.project_id ?? null, workspaceDirectoryId: location.workspace_directory_id ?? null,
          parentId: location.folder_id ?? null,
        })
      const [rawFiles, rawFolders] = await Promise.all([filesPromise, foldersPromise])
      signal.throwIfAborted()
      const files = page(rawFiles), folders = page(rawFolders)
      return {
        files: files.items,
        folders: folders.items,
        files_has_more: files.has_more,
        next_file_cursor: files.next_cursor,
        ...(files.total !== undefined ? { total: files.total } : {}),
        folders_has_more: folders.has_more,
        next_folder_cursor: folders.next_cursor,
      }
    },
  }
}
