import { CoreError, dataContext } from '@gugu/core'
import type { Fields } from '@gugu/core'
import type { Pool, PoolClient } from 'pg'
import { isPostgresUniqueViolation } from '../../../adapters/postgres-errors.js'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import type { WorkspaceCreateResponse } from './workspace-create.js'

type WorkspaceKind = 'folder' | 'project' | 'directory'

export interface WorkspaceUpdateInput extends Fields {
  name?: string | null
  enabled?: boolean | null
}

/** Service ValueError/LookupError status mapping from PATCH /workspaces/{id}. */
export class WorkspaceUpdateError extends Error {
  constructor(readonly statusCode: 400 | 404, message: string) {
    super(message)
    this.name = 'WorkspaceUpdateError'
  }
}

interface NormalizedWorkspaceUpdate {
  name: string | null
  enabled: boolean | null
}

interface WorkspaceRow extends Record<string, unknown> {
  id: number
  user_id: string
  name: string
  kind: WorkspaceKind
  folder_id: number | null
  project_id: number | null
  directory_id: number | null
  enabled: boolean
  is_default: boolean
}

function normalize(input: Fields): NormalizedWorkspaceUpdate {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new CoreError('invalid_request', '请求内容必须是对象')
  const value = input as Record<string, unknown>
  let name: string | null = null
  let enabled: boolean | null = null
  if ('name' in value && value.name !== null && value.name !== undefined) {
    if (typeof value.name !== 'string') throw new CoreError('invalid_request', '名称必须是文本或空值')
    const length = Array.from(value.name).length
    if (length < 1 || length > 200) throw new CoreError('invalid_request', '名称长度必须为 1 至 200 个字符')
    name = value.name
  }
  if ('enabled' in value && value.enabled !== null && value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') throw new CoreError('invalid_request', 'enabled 必须是布尔值或空值')
    enabled = value.enabled
  }
  return { name, enabled }
}

function validateDirectoryDisplayName(value: string): string {
  const name = value.trim()
  if (!name) throw new WorkspaceUpdateError(400, 'Workspace 名称不能为空')
  const safe = name.replace(/[\\/:*?"<>|]/g, '_')
  if (['workspace', 'shell', '个人文件', '项目文件', '思维', '素材板'].includes(safe) || name.toLowerCase() === 'default')
    throw new WorkspaceUpdateError(400, 'Workspace 名称与系统目录冲突')
  return name
}

async function loadOwnedWorkspace(client: PoolClient, ownerId: string, workspaceId: number): Promise<WorkspaceRow> {
  const result = await client.query<WorkspaceRow>(
    `SELECT id, user_id::text AS user_id, name, kind, folder_id, project_id,
            directory_id, enabled, is_default
     FROM workspaces WHERE id = $1 AND user_id = $2`,
    [workspaceId, ownerId],
  )
  const row = result.rows[0]
  if (!row) throw new WorkspaceUpdateError(404, '工作区不存在')
  return row
}

async function updateWorkspaceDirectoryName(
  client: PoolClient,
  ownerId: string,
  directoryId: number,
  rawName: string,
): Promise<void> {
  const result = await client.query<{
    id: number
    name: string
    is_system: boolean
  } & Record<string, unknown>>(
    `SELECT id, name, is_system FROM workspace_directories
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [directoryId, ownerId],
  )
  const directory = result.rows[0]
  if (!directory) throw new WorkspaceUpdateError(404, 'Workspace 不存在')
  if (directory.is_system) throw new WorkspaceUpdateError(400, '默认 Workspace 不可重命名')

  const name = validateDirectoryDisplayName(rawName)
  if (name === directory.name) return

  const duplicate = await client.query(
    `SELECT id FROM workspace_directories
     WHERE user_id = $1 AND name = $2 AND deleted_at IS NULL AND id <> $3`,
    [ownerId, name, directoryId],
  )
  if (duplicate.rowCount) throw new WorkspaceUpdateError(400, 'Workspace 已存在')

  try {
    await client.query(
      `UPDATE workspace_directories SET name = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [directoryId, ownerId, name],
    )
    // Display names fan out to all bindings owned by this user. directory_name remains the
    // frozen physical segment referenced by file storage keys and sandbox mounts.
    await client.query(
      `UPDATE workspaces SET name = $3, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND directory_id = $2`,
      [ownerId, directoryId, name],
    )
  } catch (error) {
    if (isPostgresUniqueViolation(error)) throw new WorkspaceUpdateError(400, 'Workspace 已存在')
    throw error
  }
}

async function countBoundSessions(client: PoolClient, ownerId: string, workspaceId: number): Promise<number> {
  const result = await client.query<{ count: string } & Record<string, unknown>>(
    `SELECT COUNT(id)::text AS count FROM conversation_sessions
     WHERE user_id = $1 AND workspace_id = $2`,
    [ownerId, workspaceId],
  )
  return Number(result.rows[0]?.count ?? 0)
}

async function toResponse(
  client: PoolClient,
  ownerId: string,
  workspaceId: number,
): Promise<WorkspaceCreateResponse> {
  const row = await loadOwnedWorkspace(client, ownerId, workspaceId)
  return {
    id: Number(row.id),
    name: row.name,
    kind: row.kind,
    folderId: row.folder_id == null ? null : Number(row.folder_id),
    projectId: row.project_id == null ? null : Number(row.project_id),
    directoryId: row.directory_id == null ? null : Number(row.directory_id),
    enabled: row.enabled,
    isDefault: row.is_default,
    boundSessionCount: await countBoundSessions(client, ownerId, workspaceId),
  }
}

/** Port of PATCH /api/v1/workspaces/{id}; directory display renames preserve the physical path. */
export function createPostgresWorkspaceUpdater(pool: Pool) {
  return async function updateWorkspace(
    authenticatedOwnerId: string,
    workspaceId: number,
    rawInput: Fields,
  ): Promise<WorkspaceCreateResponse> {
    let ownerId: string
    let input: NormalizedWorkspaceUpdate
    try {
      ownerId = dataContext(authenticatedOwnerId).ownerId
      input = normalize(rawInput)
    } catch (error) {
      if (error instanceof CoreError) throw error
      throw new CoreError('invalid_request', error instanceof Error ? error.message : '工作区字段无效')
    }
    if (!Number.isSafeInteger(workspaceId) || workspaceId < 1)
      throw new CoreError('invalid_request', '工作区 ID 无效')
    return withPostgresTransaction(pool, async (client) => {
      const workspace = await loadOwnedWorkspace(client, ownerId, workspaceId)
      if (input.name !== null) {
        const name = input.name.trim()
        if (!name) throw new WorkspaceUpdateError(400, '工作区名称不能为空')
        if (workspace.kind === 'directory') {
          if (workspace.directory_id === null)
            throw new WorkspaceUpdateError(404, '工作区目录不存在')
          await updateWorkspaceDirectoryName(client, ownerId, workspace.directory_id, name)
        } else {
          await client.query(
            `UPDATE workspaces SET name = $3, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND user_id = $2`,
            [workspaceId, ownerId, name],
          )
        }
      }
      if (input.enabled !== null) {
        await client.query(
          `UPDATE workspaces SET enabled = $3, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND user_id = $2`,
          [workspaceId, ownerId, input.enabled],
        )
      }
      return toResponse(client, ownerId, workspaceId)
    })
  }
}
