import type { Fields } from '@gugu/core'
import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../../adapters/database/postgres-transaction.js'
import { createWorkspaceDeclarationCreator } from '@gugu/core/workspace-declarations'

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
    [ownerId, input.name, input.kind, input.folderId, input.projectId, input.directoryId, input.enabled],
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
  return createWorkspaceDeclarationCreator({
    transaction: work => withPostgresTransaction(pool, client => work({
      relationExists: (owner, kind, id) => relationExists(client,
        kind === 'folder' ? 'folders' : kind === 'project' ? 'projects' : 'workspace_directories', owner, id, kind === 'directory'),
      insert: (owner, input) => createInTransaction(client, owner, input),
      async get() { throw new Error('创建事务不支持读取工作区') },
      async renameDirectory() { throw new Error('创建事务不支持目录改名') },
      async update() { throw new Error('创建事务不支持更新工作区') },
    })),
  })
}
