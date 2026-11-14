import { CoreError, dataContext } from '@gugu/core'
import type { Fields } from '@gugu/core'
import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'

type WorkspaceKind = 'folder' | 'project' | 'directory'

export interface WorkspaceCreateInput extends Fields {
  name: string
  kind?: WorkspaceKind
  folderId?: number | null
  projectId?: number | null
  directoryId?: number | null
  enabled?: boolean
}

export interface WorkspaceCreateResponse {
  id: number
  name: string
  kind: WorkspaceKind
  folderId: number | null
  projectId: number | null
  directoryId: number | null
  enabled: boolean
  isDefault: boolean
  boundSessionCount: number
}

interface NormalizedWorkspaceCreate {
  name: string
  kind: WorkspaceKind
  folderId: number | null
  projectId: number | null
  directoryId: number | null
  enabled: boolean
}

function invalid(message: string): never {
  throw new CoreError('invalid_request', message)
}

function optionalId(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    invalid(`${label} 必须是正整数或空值`)
  return value
}

function normalize(input: Fields): NormalizedWorkspaceCreate {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    invalid('请求内容必须是对象')
  const value = input as Record<string, unknown>
  if (typeof value.name !== 'string') invalid('名称必须是文本')
  const nameLength = Array.from(value.name).length
  if (nameLength < 1 || nameLength > 200) invalid('名称长度必须为 1 至 200 个字符')
  const kind = value.kind === undefined ? 'folder' : value.kind
  if (kind !== 'folder' && kind !== 'project' && kind !== 'directory')
    invalid('工作区类型无效')
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    invalid('enabled 必须是布尔值')
  return {
    name: value.name.trim(),
    kind,
    folderId: optionalId(value.folderId, 'folderId'),
    projectId: optionalId(value.projectId, 'projectId'),
    directoryId: optionalId(value.directoryId, 'directoryId'),
    enabled: value.enabled === undefined ? true : value.enabled,
  }
}

async function relationExists(
  client: PoolClient,
  table: 'folders' | 'projects' | 'workspace_directories',
  ownerId: string,
  id: number | null,
  includeDeleted: boolean,
): Promise<boolean> {
  if (id === null) return false
  const liveFilter = includeDeleted ? ' AND deleted_at IS NULL' : ''
  const result = await client.query(
    `SELECT id FROM ${table} WHERE id = $1 AND user_id = $2${liveFilter}`,
    [id, ownerId],
  )
  return result.rowCount === 1
}

async function createInTransaction(
  client: PoolClient,
  ownerId: string,
  input: NormalizedWorkspaceCreate,
): Promise<WorkspaceCreateResponse> {
  let folderId: number | null = input.folderId
  let projectId: number | null = input.projectId
  let directoryId: number | null = null

  if (input.kind === 'folder') {
    if (!(await relationExists(client, 'folders', ownerId, folderId, false)))
      throw new CoreError('conflict', '文件夹不存在')
    projectId = null
  } else if (input.kind === 'project') {
    if (!(await relationExists(client, 'projects', ownerId, projectId, false)))
      throw new CoreError('conflict', '项目不存在')
    folderId = null
  } else {
    directoryId = input.directoryId
    if (!(await relationExists(client, 'workspace_directories', ownerId, directoryId, true)))
      throw new CoreError('conflict', 'Workspace 目录不存在')
    folderId = null
    projectId = null
  }

  const inserted = await client.query<{
    id: number
    name: string
    kind: WorkspaceKind
    folder_id: number | null
    project_id: number | null
    directory_id: number | null
    enabled: boolean
    is_default: boolean
  }>(
    `INSERT INTO workspaces
       (user_id, name, kind, folder_id, project_id, directory_id, enabled, is_default)
     VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
     RETURNING id, name, kind, folder_id, project_id, directory_id, enabled, is_default`,
    [ownerId, input.name, input.kind, folderId, projectId, directoryId, input.enabled],
  )
  const row = inserted.rows[0]
  if (!row) throw new Error('工作区创建后未返回记录')
  return {
    id: Number(row.id),
    name: row.name,
    kind: row.kind,
    folderId: row.folder_id,
    projectId: row.project_id,
    directoryId: row.directory_id,
    enabled: row.enabled,
    isDefault: row.is_default,
    boundSessionCount: 0,
  }
}

/** Port of POST /api/v1/workspaces; relation checks and declaration insert share one PG transaction. */
export function createPostgresWorkspaceCreator(pool: Pool) {
  return async function createWorkspace(
    authenticatedOwnerId: string,
    rawInput: Fields,
  ): Promise<WorkspaceCreateResponse> {
    let ownerId: string
    let input: NormalizedWorkspaceCreate
    try {
      ownerId = dataContext(authenticatedOwnerId).ownerId
      input = normalize(rawInput)
    } catch (error) {
      if (error instanceof CoreError) throw error
      throw new CoreError('invalid_request', error instanceof Error ? error.message : '工作区字段无效')
    }
    return withPostgresTransaction(pool, (client) => createInTransaction(client, ownerId, input))
  }
}
