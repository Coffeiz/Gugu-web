import { CoreError } from '@gugu/core'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { withPostgresTransaction } from '../../adapters/postgres-transaction.js'
import type { FolderCreateInput, FolderMoveInput, FolderRenameInput, FolderWriteMetadata, FolderWriteOperations } from './folder-writes.js'
import type { PreparedPathMirrorMutation } from './local-path-mirror.js'

export interface FolderWriteRecord {
  id: number
  userId: string
  projectId: number | null
  workspaceDirectoryId: number | null
  parentId: number | null
  name: string
  fileCount: number
  folderCount: number
  version: number
}

export interface FolderUndoRecord {
  userId: string
  contextId: string | null
  action: 'create' | 'rename' | 'move'
  folder: FolderWriteRecord
  before: FolderWriteRecord | null
  fileChanges: readonly NonNullable<PreparedPathMirrorMutation['fileChanges']>[number][]
}

export interface FolderChangedEvent {
  ownerId: string
  origin: string | null
  operation: 'create' | 'update'
  folder: FolderWriteRecord
}

export interface FolderWriteRuntime {
  /** Uses the same locale-independent candidate builder as the Python search index. */
  buildSearchRomaji(name: string): string
  /** Required Local PathMirror planner. It resolves old/new logical keys from the in-transaction DB state. */
  preparePathMirrorMutation(
    client: PoolClient,
    ownerId: string,
    folderId: number,
    action: 'create' | 'rename' | 'move',
    beforeName: string | null,
    previousDirectoryKeys?: string[],
  ): Promise<PreparedPathMirrorMutation>
  capturePathMirrorDirectoryKeys(client: PoolClient, ownerId: string, folderId: number): Promise<string[]>
  /** Persists the forward undo operation in the same DB transaction as the mutation. */
  recordForwardUndo(client: PoolClient, record: FolderUndoRecord): Promise<void>
  /** Event publication is post-commit and must not make a committed write appear to have failed. */
  publishChanged(event: FolderChangedEvent): Promise<void>
  /** Reports failed old-directory cleanup after commit; the database and moved files remain authoritative. */
  onPathCleanupFailure(errorType: string): void
  /** Reports failed compensation without exposing paths, owners, file names, or exception messages. */
  onPathRollbackFailure(errorType: string): void
}

type FolderRow = QueryResultRow & {
  id: number | string
  user_id: string
  project_id: number | string | null
  workspace_directory_id: number | string | null
  parent_id: number | string | null
  name: string
  version: number | string
}

function record(row: FolderRow, fileCount = 0, folderCount = 0): FolderWriteRecord {
  return {
    id: Number(row.id), userId: String(row.user_id),
    projectId: row.project_id === null ? null : Number(row.project_id),
    workspaceDirectoryId: row.workspace_directory_id === null ? null : Number(row.workspace_directory_id),
    parentId: row.parent_id === null ? null : Number(row.parent_id),
    name: String(row.name), fileCount, folderCount, version: Number(row.version),
  }
}

async function fetchFolder(client: PoolClient, ownerId: string, folderId: number): Promise<FolderRow | null> {
  const result = await client.query<FolderRow>(
    `SELECT id,user_id::text AS user_id,project_id,workspace_directory_id,parent_id,name,version
     FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`,
    [folderId, ownerId],
  )
  return result.rows[0] ?? null
}

async function counts(client: PoolClient, ownerId: string, folderId: number): Promise<{ fileCount: number; folderCount: number }> {
  const result = await client.query<{ file_count: number | string; folder_count: number | string }>(
    `SELECT
       (SELECT count(*)::int FROM files WHERE user_id=$1 AND folder_id=$2 AND deleted_at IS NULL) AS file_count,
       (SELECT count(*)::int FROM folders WHERE user_id=$1 AND parent_id=$2 AND deleted_at IS NULL) AS folder_count`,
    [ownerId, folderId],
  )
  const row = result.rows[0]
  return { fileCount: Number(row?.file_count ?? 0), folderCount: Number(row?.folder_count ?? 0) }
}

async function validateScope(client: PoolClient, ownerId: string, input: FolderCreateInput): Promise<void> {
  if (input.projectId !== null && input.workspaceDirectoryId !== null)
    throw new CoreError('invalid_request', '项目与 Workspace 目录不能同时指定')
  if (input.projectId !== null) {
    const project = await client.query('SELECT id FROM projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [input.projectId, ownerId])
    if (!project.rowCount) throw new CoreError('not_found', '项目不存在')
  }
  if (input.workspaceDirectoryId !== null) {
    const workspace = await client.query('SELECT id FROM workspace_directories WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [input.workspaceDirectoryId, ownerId])
    if (!workspace.rowCount) throw new CoreError('not_found', 'Workspace 不存在')
  }
  if (input.parentId !== null) {
    const parent = await client.query<FolderRow>(
      `SELECT id,user_id::text AS user_id,project_id,workspace_directory_id,parent_id,name,version
       FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
      [input.parentId, ownerId],
    )
    const row = parent.rows[0]
    if (!row || (row.project_id === null ? null : Number(row.project_id)) !== input.projectId
      || (row.workspace_directory_id === null ? null : Number(row.workspace_directory_id)) !== input.workspaceDirectoryId)
      throw new CoreError('invalid_request', '目标文件夹不属于目标空间')
  }
}

async function recordUndoAndRefresh(
  client: PoolClient,
  runtime: FolderWriteRuntime,
  ownerId: string,
  metadata: FolderWriteMetadata,
  action: 'create' | 'rename' | 'move',
  current: FolderRow,
  before: FolderRow | null,
  fileChanges: FolderUndoRecord['fileChanges'],
): Promise<FolderWriteRecord> {
  const count = await counts(client, ownerId, Number(current.id))
  const after = record(current, count.fileCount, count.folderCount)
  await runtime.recordForwardUndo(client, {
    userId: ownerId,
    contextId: metadata.undoContextId,
    action,
    folder: after,
    before: before ? record(before) : null,
    fileChanges,
  })
  return after
}

async function runMutation<T>(pool: Pool, ownerId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withPostgresTransaction(pool, async (client) => {
    // Serialize tree path changes per owner so a parent rename cannot race a child path plan.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('gugu-folder-tree'))", [ownerId])
    return work(client)
  })
}

function translateFolderConflict(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error && error.code === '23505'
    && 'constraint' in error && error.constraint === 'uq_folders_active_scope_name')
    throw new CoreError('conflict', '同名文件夹已存在')
  throw error
}

function cleanupErrorType(error: unknown): string {
  if (error instanceof Error && error.name === 'PathMirrorMutationError') return 'PathMirrorMutationError'
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return 'NodeError'
  if (error instanceof Error && error.name === 'Error') return 'Error'
  return 'UnknownError'
}

async function finalizePathMutation(
  mutation: PreparedPathMirrorMutation | null,
  runtime: FolderWriteRuntime,
): Promise<void> {
  if (!mutation) return
  try {
    await mutation.finalize()
  } catch (error) {
    try {
      runtime.onPathCleanupFailure(cleanupErrorType(error))
    } catch {
      // A diagnostic sink failure must not turn an already committed mutation into an apparent failure.
    }
  }
}

async function rollbackPathMutation(
  mutation: PreparedPathMirrorMutation | null,
  runtime: FolderWriteRuntime,
): Promise<void> {
  if (!mutation) return
  try {
    await mutation.rollback()
  } catch (error) {
    try {
      runtime.onPathRollbackFailure(cleanupErrorType(error))
    } catch {
      // Preserve the original transaction error even if diagnostics are unavailable.
    }
  }
}

export function createPostgresFolderWriteOperations(pool: Pool, runtime: FolderWriteRuntime): FolderWriteOperations {
  return {
    async create(ownerId, input, metadata) {
      let pathMutation: PreparedPathMirrorMutation | null = null
      let committed = false
      try {
        const result = await runMutation(pool, ownerId, async (client) => {
          await validateScope(client, ownerId, input)
          const inserted = await client.query<FolderRow>(
            `INSERT INTO folders (user_id,project_id,workspace_directory_id,parent_id,name,search_romaji,version,deleted_at,created_at,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
             RETURNING id,user_id::text AS user_id,project_id,workspace_directory_id,parent_id,name,version`,
            [ownerId, input.projectId, input.workspaceDirectoryId, input.parentId, input.name, runtime.buildSearchRomaji(input.name)],
          )
          const row = inserted.rows[0]
          if (!row) throw new Error('文件夹创建后未返回记录')
          pathMutation = await runtime.preparePathMirrorMutation(client, ownerId, Number(row.id), 'create', null)
          await pathMutation.apply()
          return recordUndoAndRefresh(client, runtime, ownerId, metadata, 'create', row, null, pathMutation.fileChanges ?? [])
        })
        committed = true
        await finalizePathMutation(pathMutation, runtime)
        await runtime.publishChanged({ ownerId, origin: metadata.origin, operation: 'create', folder: result })
          .catch(() => undefined)
        return { id: result.id, projectId: result.projectId, workspaceDirectoryId: result.workspaceDirectoryId,
          parentId: result.parentId, name: result.name, fileCount: result.fileCount,
          folderCount: result.folderCount, version: result.version }
      } catch (error) {
        if (!committed) await rollbackPathMutation(pathMutation, runtime)
        translateFolderConflict(error)
      }
    },
    async rename(ownerId, folderId, input, metadata) {
      let pathMutation: PreparedPathMirrorMutation | null = null
      let committed = false
      try {
        const result = await runMutation(pool, ownerId, async (client) => {
          const before = await fetchFolder(client, ownerId, folderId)
          if (!before) throw new CoreError('not_found', '文件夹不存在')
          const updated = await client.query<FolderRow>(
            `UPDATE folders SET name=$1,search_romaji=$2,version=version+1,updated_at=CURRENT_TIMESTAMP
             WHERE id=$3 AND user_id=$4 AND deleted_at IS NULL AND version=$5
             RETURNING id,user_id::text AS user_id,project_id,workspace_directory_id,parent_id,name,version`,
            [input.name, runtime.buildSearchRomaji(input.name), folderId, ownerId, input.version],
          )
          const row = updated.rows[0]
          if (!row) throw new CoreError('conflict', '文件夹已被修改，请刷新后重试')
          pathMutation = await runtime.preparePathMirrorMutation(client, ownerId, folderId, 'rename', before.name)
          await pathMutation.apply()
          const after = await recordUndoAndRefresh(client, runtime, ownerId, metadata, 'rename', row, before, pathMutation.fileChanges ?? [])
          return after
        })
        committed = true
        await finalizePathMutation(pathMutation, runtime)
        await runtime.publishChanged({ ownerId, origin: metadata.origin, operation: 'update', folder: result })
          .catch(() => undefined)
        return { id: result.id, projectId: result.projectId, workspaceDirectoryId: result.workspaceDirectoryId,
          parentId: result.parentId, name: result.name, fileCount: result.fileCount,
          folderCount: result.folderCount, version: result.version }
      } catch (error) {
        if (!committed) await rollbackPathMutation(pathMutation, runtime)
        translateFolderConflict(error)
      }
    },
    async move(ownerId, folderId, input: FolderMoveInput, metadata) {
      let pathMutation: PreparedPathMirrorMutation | null = null
      let committed = false
      try {
        const result = await runMutation(pool, ownerId, async (client) => {
          const before = await fetchFolder(client, ownerId, folderId)
          if (!before) throw new CoreError('not_found', '文件夹不存在')
          if (Number(before.version) !== input.version)
            throw new CoreError('conflict', '文件夹已被修改，请刷新后重试')

          const targetProjectId = input.projectSet ? input.projectId : nullableNumber(before.project_id)
          const targetWorkspaceId = input.workspaceDirectorySet
            ? input.workspaceDirectoryId
            : nullableNumber(before.workspace_directory_id)
          if (targetProjectId !== null && targetWorkspaceId !== null)
            throw new CoreError('invalid_request', '项目与 Workspace 目录不能同时指定')
          if (input.projectSet && targetProjectId !== null) {
            const project = await client.query(
              'SELECT 1 FROM projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
              [targetProjectId, ownerId],
            )
            if (!project.rowCount) throw new CoreError('not_found', '目标项目不存在')
          }
          if (input.workspaceDirectorySet && targetWorkspaceId !== null) {
            const workspace = await client.query(
              'SELECT 1 FROM workspace_directories WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
              [targetWorkspaceId, ownerId],
            )
            if (!workspace.rowCount) throw new CoreError('not_found', '目标 Workspace 不存在')
          }

          const subtreeResult = await client.query<{ id: number | string }>(
            `WITH RECURSIVE subtree(id,parent_id,visited) AS (
               SELECT id,parent_id,ARRAY[id]::int[] FROM folders
               WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
               UNION ALL
               SELECT child.id,child.parent_id,subtree.visited || child.id
               FROM folders child JOIN subtree ON child.parent_id=subtree.id
               WHERE child.user_id=$2 AND child.deleted_at IS NULL AND NOT child.id=ANY(subtree.visited)
             ) SELECT folder.id FROM folders folder
               WHERE folder.id IN (SELECT id FROM subtree) FOR UPDATE`,
            [folderId, ownerId],
          )
          const subtreeIds = subtreeResult.rows.map((row) => Number(row.id))
          if (!subtreeIds.length) throw new CoreError('not_found', '文件夹不存在')
          if (input.parentId !== null) {
            const parent = await client.query<FolderRow>(
              `SELECT id,user_id::text AS user_id,project_id,workspace_directory_id,parent_id,name,version
               FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`,
              [input.parentId, ownerId],
            )
            const row = parent.rows[0]
            if (!row) throw new CoreError('not_found', '目标文件夹不存在')
            if (subtreeIds.includes(Number(row.id)))
              throw new CoreError('invalid_request', '不能将文件夹移动到自身或其子文件夹中')
            if (nullableNumber(row.project_id) !== targetProjectId
              || nullableNumber(row.workspace_directory_id) !== targetWorkspaceId)
              throw new CoreError('invalid_request', '目标文件夹不属于目标空间')
          }

          const duplicate = await client.query(
            `SELECT 1 FROM folders WHERE user_id=$1 AND project_id IS NOT DISTINCT FROM $2
             AND workspace_directory_id IS NOT DISTINCT FROM $3 AND parent_id IS NOT DISTINCT FROM $4
             AND name=$5 AND deleted_at IS NULL AND id<>$6 LIMIT 1`,
            [ownerId, targetProjectId, targetWorkspaceId, input.parentId, before.name, folderId],
          )
          if (duplicate.rowCount) throw new CoreError('conflict', '目标目录下已存在同名文件夹')

          const oldDirectoryKeys = await runtime.capturePathMirrorDirectoryKeys(client, ownerId, folderId)
          const moved = await client.query<FolderRow>(
            `UPDATE folders SET parent_id=$1,project_id=$2,workspace_directory_id=$3,
               version=version+1,updated_at=CURRENT_TIMESTAMP
             WHERE id=$4 AND user_id=$5 AND deleted_at IS NULL AND version=$6
             RETURNING id,user_id::text AS user_id,project_id,workspace_directory_id,parent_id,name,version`,
            [input.parentId, targetProjectId, targetWorkspaceId, folderId, ownerId, input.version],
          )
          const root = moved.rows[0]
          if (!root) throw new CoreError('conflict', '文件夹已被修改，请刷新后重试')
          if (targetProjectId !== nullableNumber(before.project_id)
            || targetWorkspaceId !== nullableNumber(before.workspace_directory_id)) {
            await client.query(
              `UPDATE folders SET project_id=$1,workspace_directory_id=$2,updated_at=CURRENT_TIMESTAMP
               WHERE user_id=$3 AND deleted_at IS NULL AND id=ANY($4::int[]) AND id<>$5`,
              [targetProjectId, targetWorkspaceId, ownerId, subtreeIds, folderId],
            )
          }
          pathMutation = await runtime.preparePathMirrorMutation(
            client, ownerId, folderId, 'move', null, oldDirectoryKeys,
          )
          await pathMutation.apply()
          const after = await recordUndoAndRefresh(
            client, runtime, ownerId, metadata, 'move', root, before, pathMutation.fileChanges ?? [],
          )
          return after
        })
        committed = true
        await finalizePathMutation(pathMutation, runtime)
        await runtime.publishChanged({ ownerId, origin: metadata.origin, operation: 'update', folder: result })
          .catch(() => undefined)
        return { id: result.id, projectId: result.projectId, workspaceDirectoryId: result.workspaceDirectoryId,
          parentId: result.parentId, name: result.name, fileCount: result.fileCount,
          folderCount: result.folderCount, version: result.version }
      } catch (error) {
        if (!committed) await rollbackPathMutation(pathMutation, runtime)
        translateFolderConflict(error)
      }
    },
  }
}

function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value)
}
