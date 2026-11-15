import { CoreError } from '@gugu/core'
import { planFolderSoftDelete } from '@gugu/core/files/folder-delete'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { createLocalPathMirrorMutation, localPathMirrorEntryExists } from '../../domains/files/local-path-mirror.js'
import { lockFileSyncPath, lockFileSyncPaths } from '../../domains/files/persistence/file-sync-canonical-change.js'
import type { FolderDeleteMetadata, FolderDeleteOperations } from './folder-delete.js'

interface FolderRow extends QueryResultRow {
  id: number | string
  user_id: string
  parent_id: number | string | null
  project_id: number | string | null
  workspace_directory_id: number | string | null
  name: string
  version: number | string
  deleted_at: Date | string | null
}

interface FileRow extends QueryResultRow {
  id: number | string
  user_id: string
  folder_id: number | string | null
  display_name: string
  ext: string
  storage_key: string
  storage_backend: string
  deleted_at: Date | string | null
}

export interface FolderDeleteUndoRecord {
  contextId: string | null
  userId: string
  before: FolderRow
  after: FolderRow
}

export interface FolderDeleteRuntime {
  storageRoot: string
  captureDirectoryKeys(client: PoolClient, ownerId: string, folderId: number): Promise<string[]>
  publishChanged(event: { ownerId: string; folderId: number; origin: string | null }): Promise<void>
  onPathCleanupFailure?(errorType: string): void
  onPathRollbackFailure?(errorType: string): void
}

function safeName(value: string): string { return value.replace(/[\\/:*?"<>|]/g, '_') }

function trashKey(ownerId: string, storageKey: string, displayName: string, ext: string, suffix = 0): string {
  const prefix = `${ownerId}/`
  const parent = storageKey.slice(0, storageKey.lastIndexOf('/'))
  let logicalParent = parent.startsWith(prefix) ? parent.slice(prefix.length) : ''
  logicalParent = logicalParent.includes('/') ? logicalParent.slice(logicalParent.indexOf('/') + 1) : ''
  const name = suffix ? `${displayName}(${suffix})` : displayName
  return `${ownerId}/trash/${logicalParent ? `${logicalParent}/` : ''}${safeName(name)}${ext ? `.${ext.toLowerCase()}` : ''}`
}

async function availableTrashKey(
  client: PoolClient, root: string, ownerId: string, file: FileRow, reserved: Set<string>,
): Promise<string> {
  for (let suffix = 0; ; suffix += 1) {
    const candidate = trashKey(ownerId, file.storage_key, file.display_name, file.ext, suffix)
    await lockFileSyncPath(client, ownerId, candidate)
    if (reserved.has(candidate) || await localPathMirrorEntryExists(root, ownerId, candidate)) continue
    const row = await client.query('SELECT 1 FROM files WHERE user_id=$1 AND storage_key=$2 LIMIT 1', [ownerId, candidate])
    if (!row.rowCount) return candidate
  }
}

function folderSnapshot(row: FolderRow) {
  return {
    id: Number(row.id), name: row.name,
    project_id: row.project_id == null ? null : Number(row.project_id),
    workspace_directory_id: row.workspace_directory_id == null ? null : Number(row.workspace_directory_id),
    parent_id: row.parent_id == null ? null : Number(row.parent_id),
    version: Number(row.version),
    deleted_at: row.deleted_at instanceof Date ? row.deleted_at.toISOString() : row.deleted_at,
  }
}

async function recordFolderDeleteUndo(client: PoolClient, record: FolderDeleteUndoRecord): Promise<void> {
  const contextId = record.contextId?.trim().slice(0, 128)
  if (!contextId) return
  const ref = `folder:${record.after.id}`
  await client.query(
    `UPDATE undo_operations SET status='expired',failure_code='redo_cleared_by_new_operation'
     WHERE user_id=$1 AND undo_context_id=$2 AND actor_type='web' AND status='undone'`,
    [record.userId, contextId],
  )
  await client.query(
    `INSERT INTO undo_operations (
       id,user_id,undo_context_id,group_id,resource,action,target_refs,before_state,after_state,
       base_versions,artifact_refs,actor_type,status,created_at,expires_at,undone_at,failure_code
     ) VALUES ($1,$2,$3,$4,'files','delete',$5::json,$6::json,$7::json,$8::json,'{}'::json,
       'web','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '30 days',NULL,NULL)`,
    [
      `op-${randomUUID().replaceAll('-', '')}`, record.userId, contextId,
      `group-${randomUUID().replaceAll('-', '')}`,
      JSON.stringify([{ kind: 'folder', id: Number(record.after.id) }]),
      JSON.stringify({ items: { [ref]: folderSnapshot(record.before) } }),
      JSON.stringify({ items: { [ref]: folderSnapshot(record.after) } }),
      JSON.stringify({ [ref]: { version: Number(record.before.version) } }),
    ],
  )
}

function errorType(error: unknown): string {
  if (error instanceof Error && error.name === 'PathMirrorMutationError') return error.name
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return 'NodeError'
  return error instanceof Error ? 'Error' : 'UnknownError'
}

export function createPostgresFolderDeleteOperations(pool: Pool, runtime: FolderDeleteRuntime): FolderDeleteOperations {
  return {
    async remove(ownerId, folderId, metadata: FolderDeleteMetadata) {
      if (!Number.isSafeInteger(folderId) || folderId < 1) throw new CoreError('invalid_request', '文件夹 ID 无效')
      const client = await pool.connect()
      let mutation: ReturnType<typeof createLocalPathMirrorMutation> | null = null
      let commitAttempted = false
      let committed = false
      let rootAfter: FolderRow | undefined
      try {
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('gugu-folder-tree'))", [ownerId])
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('file-trash:' || $1, 0))", [ownerId])
        const tree = await client.query<FolderRow>(
          `WITH RECURSIVE tree AS (
             SELECT id,parent_id,ARRAY[id]::integer[] AS visited FROM folders
             WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
             UNION ALL
             SELECT child.id,child.parent_id,tree.visited || child.id FROM folders child JOIN tree ON child.parent_id=tree.id
             WHERE child.user_id=$2 AND child.deleted_at IS NULL AND NOT child.id=ANY(tree.visited)
           )
           SELECT folder.id,folder.user_id::text AS user_id,folder.parent_id,folder.project_id,
             folder.workspace_directory_id,folder.name,folder.version,folder.deleted_at
           FROM folders folder JOIN tree ON tree.id=folder.id
           WHERE folder.user_id=$2 AND folder.deleted_at IS NULL ORDER BY folder.id FOR UPDATE OF folder`,
          [folderId, ownerId],
        )
        const folders = tree.rows
        if (!folders.length) throw new CoreError('not_found', '文件夹不存在')
        const rootBefore = folders.find(row => Number(row.id) === folderId)
        if (!rootBefore) throw new CoreError('not_found', '文件夹不存在')
        const plan = planFolderSoftDelete(ownerId, folderId, folders, [])
        const folderIds = plan.folderIds
        const directoryKeys = await runtime.captureDirectoryKeys(client, ownerId, folderId)
        const fileResult = await client.query<FileRow>(
          `SELECT id,user_id::text AS user_id,folder_id,display_name,ext,storage_key,storage_backend,deleted_at
           FROM files WHERE user_id=$1 AND folder_id=ANY($2::int[]) AND deleted_at IS NULL ORDER BY storage_key,id FOR UPDATE`,
          [ownerId, folderIds],
        )
        const files = fileResult.rows
        if (files.some(file => file.storage_backend !== 'local'))
          throw new CoreError('invalid_request', '文件夹中包含暂不支持的存储类型')
        await lockFileSyncPaths(client, ownerId, files.map(file => file.storage_key))
        const filePlan = planFolderSoftDelete(ownerId, folderId, folders, files)
        const selectedFileIds = new Set(filePlan.fileIds)
        const affectedFiles = files.filter(file => selectedFileIds.has(Number(file.id)))
        const moves: Array<{ fromKey: string; toKey: string; preserveSourceUntilFinalize: true }> = []
        const changedKeys = new Map<number, string>()
        const reserved = new Set<string>()
        for (const file of affectedFiles) {
          if (file.storage_key === trashKey(ownerId, file.storage_key, file.display_name, file.ext)) continue
          let exists = false
          try { exists = await localPathMirrorEntryExists(runtime.storageRoot, ownerId, file.storage_key) }
          catch { continue }
          if (!exists) continue
          const target = await availableTrashKey(client, runtime.storageRoot, ownerId, file, reserved)
          reserved.add(target)
          moves.push({ fromKey: file.storage_key, toKey: target, preserveSourceUntilFinalize: true })
          changedKeys.set(Number(file.id), target)
        }

        mutation = createLocalPathMirrorMutation(runtime.storageRoot, ownerId, moves, [], directoryKeys)
        await mutation.apply()
        const stampResult = await client.query<{ deleted_at: Date }>('SELECT CURRENT_TIMESTAMP AS deleted_at')
        const stamp = stampResult.rows[0]?.deleted_at
        if (!stamp) throw new Error('文件夹删除未能确定时间戳')
        const folderUpdate = await client.query<FolderRow>(
          `UPDATE folders SET deleted_at=$3,updated_at=$3,version=COALESCE(version,1)+1
           WHERE id=ANY($1::int[]) AND user_id=$2 AND deleted_at IS NULL RETURNING id,user_id::text AS user_id,
             parent_id,project_id,workspace_directory_id,name,version,deleted_at`,
          [folderIds, ownerId, stamp],
        )
        if (folderUpdate.rowCount !== folderIds.length) throw new CoreError('conflict', '文件夹状态已变化，请重试')
        rootAfter = folderUpdate.rows.find(row => Number(row.id) === folderId)
        if (!rootAfter) throw new CoreError('conflict', '文件夹状态已变化，请重试')
        await client.query(
          'UPDATE workspaces SET folder_id=NULL WHERE user_id=$1 AND folder_id=ANY($2::int[])', [ownerId, folderIds],
        )
        for (const file of affectedFiles) {
          const key = changedKeys.get(Number(file.id))
          if (key) {
            await client.query(
              'UPDATE files SET storage_key=$3,deleted_at=$4,updated_at=$4 WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
              [Number(file.id), ownerId, key, stamp],
            )
          } else {
            await client.query(
              'UPDATE files SET deleted_at=$3,updated_at=$3 WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
              [Number(file.id), ownerId, stamp],
            )
          }
        }
        await recordFolderDeleteUndo(client, {
          contextId: metadata.undoContextId, userId: ownerId, before: rootBefore, after: rootAfter,
        })
        commitAttempted = true
        await client.query('COMMIT')
        committed = true
      } catch (error) {
        if (!commitAttempted) {
          await client.query('ROLLBACK').catch(() => undefined)
          if (mutation) await mutation.rollback().catch(rollbackError => {
            runtime.onPathRollbackFailure?.(errorType(rollbackError))
          })
        } else {
          console.error('文件夹删除提交结果未知，保留原文件与回收站副本供核查')
        }
        throw error
      } finally { client.release() }

      if (!committed || !rootAfter) return
      if (mutation) await mutation.finalize().catch(error => runtime.onPathCleanupFailure?.(errorType(error)))
      await runtime.publishChanged({ ownerId, folderId, origin: metadata.origin }).catch(() => undefined)
    },
  }
}
