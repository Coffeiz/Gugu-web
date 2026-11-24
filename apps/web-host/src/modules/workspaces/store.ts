import { createWorkspaceLister, type WorkspaceListReadPort, type WorkspaceListRow, type WorkspaceListRuntime, type Fields, CoreError, createWorkspaceDeleter, type WorkspaceDeletionTransaction } from '@gugu/core'
import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../adapters/database/postgres-transaction.js'
import { createWorkspaceDeclarationCreator, createWorkspaceDeclarationUpdater, WorkspaceUpdateError } from '@gugu/core/workspace-declarations'
import { isPostgresUniqueViolation } from '../../adapters/database/postgres-errors.js'
import { enqueueScheduledTaskRagRebuild } from '../scheduled-tasks/store.js'

export type { WorkspaceListRuntime, WorkspaceListRuntimeSettings, WorkspaceListTerminalMode } from '@gugu/core'

type ListRow = WorkspaceListRow & Record<string, unknown>

interface CountRow extends Record<string, unknown> {
  workspace_id: number
  count: string
}

/** Host 只提供 owner-scoped PostgreSQL 读取；偏好、运行能力与列表投影复用 Core。 */
export function createPostgresWorkspaceLister(pool: Pool, runtime: WorkspaceListRuntime) {
  const store: WorkspaceListReadPort = {
    async preferences(ownerId) {
      const result = await pool.query<{ data_json: string } & Record<string, unknown>>(
        'SELECT data_json FROM user_preferences WHERE user_id = $1',
        [ownerId],
      )
      return result.rows[0]?.data_json
    },
    async workspaces(ownerId) {
      const result = await pool.query<ListRow>(
        `SELECT id, name, kind, project_id, directory_id, enabled, is_default
       FROM workspaces WHERE user_id = $1 ORDER BY updated_at DESC`,
        [ownerId],
      )
      return result.rows
    },
    async boundSessionCounts(ownerId) {
      const result = await pool.query<CountRow>(
        `SELECT workspace_id, COUNT(id)::text AS count FROM conversation_sessions
       WHERE user_id = $1 AND workspace_id IS NOT NULL GROUP BY workspace_id`,
        [ownerId],
      )
      return result.rows
    },
  }
  return createWorkspaceLister(store, runtime)
}

type WorkspaceKind = 'project' | 'directory'

export interface WorkspaceCreateInput extends Fields {
  name: string
  kind?: WorkspaceKind
  projectId?: number | null
  directoryId?: number | null
  enabled?: boolean
}

export interface WorkspaceCreateResponse {
  id: number
  name: string
  kind: WorkspaceKind
  projectId: number | null
  directoryId: number | null
  enabled: boolean
  isDefault: boolean
  boundSessionCount: number
}

interface NormalizedWorkspaceCreate {
  name: string
  kind: WorkspaceKind
  projectId: number | null
  directoryId: number | null
  enabled: boolean
}

async function relationExists(
  client: PoolClient,
  table: 'projects' | 'workspace_directories',
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
    project_id: number | null
    directory_id: number | null
    enabled: boolean
    is_default: boolean
  }>(
    `INSERT INTO workspaces
       (user_id, name, kind, project_id, directory_id, enabled, is_default)
     VALUES ($1, $2, $3, $4, $5, $6, FALSE)
     RETURNING id, name, kind, project_id, directory_id, enabled, is_default`,
    [ownerId, input.name, input.kind, input.projectId, input.directoryId, input.enabled],
  )
  const row = inserted.rows[0]
  if (!row) throw new Error('工作区创建后未返回记录')
  return {
    id: Number(row.id),
    name: row.name,
    kind: row.kind,
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
        kind === 'project' ? 'projects' : 'workspace_directories', owner, id, kind === 'directory'),
      insert: (owner, input) => createInTransaction(client, owner, input),
      async get() { throw new Error('创建事务不支持读取工作区') },
      async renameDirectory() { throw new Error('创建事务不支持目录改名') },
      async update() { throw new Error('创建事务不支持更新工作区') },
    })),
  })
}

export interface WorkspaceUpdateInput extends Fields {
  name?: string | null
  enabled?: boolean | null
}

/** Service ValueError/LookupError status mapping from PATCH /workspaces/{id}. */
interface WorkspaceRow extends Record<string, unknown> {
  id: number
  user_id: string
  name: string
  kind: WorkspaceKind
  project_id: number | null
  directory_id: number | null
  enabled: boolean
  is_default: boolean
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
    `SELECT id, user_id::text AS user_id, name, kind, project_id,
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
    projectId: row.project_id == null ? null : Number(row.project_id),
    directoryId: row.directory_id == null ? null : Number(row.directory_id),
    enabled: row.enabled,
    isDefault: row.is_default,
    boundSessionCount: await countBoundSessions(client, ownerId, workspaceId),
  }
}

/** Port of PATCH /api/v1/workspaces/{id}; directory display renames preserve the physical path. */
export function createPostgresWorkspaceUpdater(pool: Pool) {
  return createWorkspaceDeclarationUpdater({
    transaction: work => withPostgresTransaction(pool, client => work({
      async relationExists() { throw new Error('更新事务不支持关联校验') },
      async insert() { throw new Error('更新事务不支持创建工作区') },
      async get(owner, id) {
        try { return await toResponse(client, owner, id) }
        catch (error) { if (error instanceof WorkspaceUpdateError && error.statusCode === 404) return null; throw error }
      },
      renameDirectory: (owner, id, name) => updateWorkspaceDirectoryName(client, owner, id, name),
      async update(owner, id, fields) {
        if (fields.name !== undefined) await client.query(
          'UPDATE workspaces SET name = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2', [id, owner, fields.name])
        if (fields.enabled !== undefined) await client.query(
          'UPDATE workspaces SET enabled = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2', [id, owner, fields.enabled])
      },
    })),
  })
}

export type { WorkspaceDeleteResult } from '@gugu/core'

/** 保留PG事务、行锁及原SQL；声明解绑规则委托Core，不删除物理资源。 */
export function createPostgresWorkspaceDeleter(pool: Pool) {
  return createWorkspaceDeleter({
    transaction: work => withPostgresTransaction(pool, client => work(createPostgresWorkspaceDeletionTransaction(client))),
  })
}

/** 供已开启 PG 事务的业务切片复用同一 owner 行锁和生命周期规则。 */
export function createPostgresWorkspaceDeletionTransaction(client: PoolClient): WorkspaceDeletionTransaction {
  return {
    async lockOwnedWorkspace(ownerId, workspaceId) {
      const owned = await client.query<{ id: number } & Record<string, unknown>>(
        `SELECT id FROM workspaces WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [workspaceId, ownerId],
      )
      return !!owned.rows[0]
    },
    async detachSessions(ownerId, workspaceId) {
      await client.query(
        `UPDATE conversation_sessions SET workspace_id = NULL
         WHERE user_id = $1 AND workspace_id = $2`,
        [ownerId, workspaceId],
      )
    },
    async disableOrdinaryTasks(ownerId, workspaceId) {
      const changed = await client.query<{ id: number }>(
        `UPDATE scheduled_tasks SET enabled = FALSE, workspace_id = NULL
         WHERE user_id = $1 AND workspace_id = $2 AND event_id IS NULL RETURNING id`,
        [ownerId, workspaceId],
      )
      for (const task of changed.rows) await enqueueScheduledTaskRagRebuild(client, ownerId, Number(task.id))
    },
    async deleteDeclaration(ownerId, workspaceId) {
      await client.query(
        `DELETE FROM workspaces WHERE id = $1 AND user_id = $2`,
        [workspaceId, ownerId],
      )
    },
  }
}
