import { CoreError } from '@gugu/core'
import { lstat, mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { isPathWithin } from '../../adapters/path-safety.js'
import { normalizeFileOwnerId } from './file-owner.js'
import type { FileDeleteOperations } from './file-delete.js'
import { lockFileSyncPath, lockFileSyncPaths } from './persistence/file-sync-canonical-change.js'

interface FileRow extends QueryResultRow {
  id: number | string
  user_id: string
  display_name: string
  ext: string
  space: string
  project_id: number | string | null
  folder_id: number | string | null
  workspace_directory_id: number | string | null
  stage_name: string
  mind_map_id: number | string | null
  storage_key: string
  version: number | string
  size: string
  size_bytes: number | string
  mime_type: string | null
  img_width: number | string | null
  img_height: number | string | null
  deleted_at: Date | string | null
}

function safeSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_')
}

function trashKey(ownerId: string, storageKey: string, displayName: string, ext: string): string {
  const prefix = `${ownerId}/`
  const parent = storageKey.slice(0, storageKey.lastIndexOf('/'))
  let logicalParent = parent.startsWith(prefix) ? parent.slice(prefix.length) : ''
  logicalParent = logicalParent.includes('/') ? logicalParent.slice(logicalParent.indexOf('/') + 1) : ''
  const filename = `${safeSegment(displayName)}${ext ? `.${ext.toLowerCase()}` : ''}`
  return `${ownerId}/trash/${logicalParent ? `${logicalParent}/` : ''}${filename}`
}

async function safePath(storageRoot: string, key: string): Promise<{ root: string; target: string }> {
  const segments = key.split('/')
  if (segments.length < 2 || segments.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')))
    throw new CoreError('storage_error', '文件存储位置无效')
  const root = await realpath(storageRoot)
  let target = root
  for (const segment of segments) {
    target = path.resolve(target, segment)
    if (!isPathWithin(root, target)) throw new CoreError('storage_error', '文件存储位置无效')
    try {
      if ((await lstat(target)).isSymbolicLink()) throw new CoreError('storage_error', '文件存储位置无效')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return { root, target }
}

async function availableTrashKey(
  client: PoolClient, storageRoot: string, ownerId: string, baseKey: string, displayName: string, ext: string,
): Promise<string> {
  let suffix = 0
  while (true) {
    const name = suffix === 0 ? displayName : `${displayName}(${suffix})`
    const key = suffix === 0 ? baseKey
      : `${baseKey.slice(0, baseKey.lastIndexOf('/') + 1)}${safeSegment(name)}${ext ? `.${ext.toLowerCase()}` : ''}`
    const diskPath = await safePath(storageRoot, key)
    const exists = await stat(diskPath.target).then(
      () => true,
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? false : Promise.reject(error),
    )
    const row = await client.query(
      'SELECT 1 FROM files WHERE user_id=$1 AND storage_key=$2 AND deleted_at IS NULL', [ownerId, key],
    )
    if (!exists && !row.rowCount) return key
    suffix++
  }
}

function snapshot(file: FileRow) {
  return {
    id: Number(file.id), display_name: file.display_name, ext: file.ext, space: file.space,
    project_id: file.project_id === null ? null : Number(file.project_id),
    folder_id: file.folder_id === null ? null : Number(file.folder_id),
    workspace_directory_id: file.workspace_directory_id === null ? null : Number(file.workspace_directory_id),
    stage_name: file.stage_name, mind_map_id: file.mind_map_id === null ? null : Number(file.mind_map_id),
    storage_key: file.storage_key, version: Number(file.version), size: file.size,
    size_bytes: Number(file.size_bytes), mime_type: file.mime_type,
    img_width: file.img_width === null ? null : Number(file.img_width),
    img_height: file.img_height === null ? null : Number(file.img_height),
    deleted_at: file.deleted_at instanceof Date ? file.deleted_at.toISOString() : file.deleted_at,
  }
}

async function recordBatchDeleteUndo(
  client: PoolClient, ownerId: string, contextId: string | null, beforeRows: FileRow[], afterRows: FileRow[],
): Promise<void> {
  const context = contextId?.trim().slice(0, 128)
  if (!context || !beforeRows.length) return
  const before = Object.fromEntries(beforeRows.map((file) => [`file:${file.id}`, snapshot(file)]))
  const after = Object.fromEntries(afterRows.map((file) => [`file:${file.id}`, snapshot(file)]))
  const refs = beforeRows.map((file) => ({ kind: 'file', id: Number(file.id) }))
  const versions = Object.fromEntries(beforeRows.map((file) => [`file:${file.id}`, { version: Number(file.version) }]))
  await client.query(
    `UPDATE undo_operations SET status='expired',failure_code='redo_cleared_by_new_operation'
     WHERE user_id=$1 AND undo_context_id=$2 AND actor_type='web' AND status='undone'`, [ownerId, context],
  )
  await client.query(
    `INSERT INTO undo_operations (id,user_id,undo_context_id,group_id,resource,action,target_refs,
       before_state,after_state,base_versions,artifact_refs,actor_type,status,created_at,expires_at,undone_at,failure_code)
     VALUES ($1,$2,$3,$4,'files','delete',$5::json,$6::json,$7::json,$8::json,'{}'::json,
       'web','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '30 days',NULL,NULL)`,
    [`op-${randomUUID().replaceAll('-', '')}`, ownerId, context, `group-${randomUUID().replaceAll('-', '')}`,
      JSON.stringify(refs), JSON.stringify({ items: before }), JSON.stringify({ items: after }), JSON.stringify(versions)],
  )
}

export function createPostgresFileDeleteOperations(
  pool: Pool,
  options: {
    storageRoot: string
    publishChanged(event: { ownerId: string; entityId: number; origin: string | null }): Promise<void>
  },
): FileDeleteOperations {
  return {
    async remove(rawOwnerId, fileId, undoContextId, clientId) {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      if (!Number.isSafeInteger(fileId)) throw new CoreError('invalid_request', '文件 ID 无效')
      const client = await pool.connect()
      let sourcePath: string | null = null
      let destinationPath: string | null = null
      let moved = false
      let committed = false
      try {
        await client.query('BEGIN')
        const result = await client.query<FileRow>(
          'SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE', [fileId, ownerId],
        )
        const before = result.rows[0]
        if (!before) throw new CoreError('not_found', '文件不存在')
        await lockFileSyncPath(client, ownerId, before.storage_key)
        sourcePath = (await safePath(options.storageRoot, before.storage_key)).target
        const destinationKey = await availableTrashKey(
          client, options.storageRoot, ownerId,
          trashKey(ownerId, before.storage_key, before.display_name, before.ext), before.display_name, before.ext,
        )
        destinationPath = (await safePath(options.storageRoot, destinationKey)).target
        await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 })
        await rename(sourcePath, destinationPath)
        moved = true
        const updated = await client.query<FileRow>(
          `UPDATE files SET storage_key=$3,deleted_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP
           WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING *`, [fileId, ownerId, destinationKey],
        )
        const after = updated.rows[0]
        if (!after) throw new CoreError('not_found', '文件不存在')
        await recordBatchDeleteUndo(client, ownerId, undoContextId, [before], [after])
        await client.query('COMMIT')
        committed = true
      } catch (error) {
        if (!committed) {
          await client.query('ROLLBACK').catch(() => undefined)
          if (moved && sourcePath && destinationPath) {
            await mkdir(path.dirname(sourcePath), { recursive: true, mode: 0o700 }).catch(() => undefined)
            await rename(destinationPath, sourcePath).catch(() => undefined)
          }
        }
        throw error
      } finally {
        client.release()
      }
      await options.publishChanged({ ownerId, entityId: fileId, origin: clientId }).catch(() => undefined)
    },

    async removeMany(rawOwnerId, fileIds, undoContextId, clientId) {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      if (fileIds.some((id) => !Number.isSafeInteger(id))) throw new CoreError('invalid_request', '文件 ID 无效')
      if (!fileIds.length) return
      const client = await pool.connect()
      const movedFiles: Array<{ sourcePath: string; destinationPath: string }> = []
      let committed = false
      let changedIds: number[] = []
      try {
        await client.query('BEGIN')
        const result = await client.query<FileRow>(
          `SELECT * FROM files WHERE id=ANY($1::integer[]) AND user_id=$2 AND deleted_at IS NULL
           ORDER BY storage_key,id FOR UPDATE`, [fileIds, ownerId],
        )
        const beforeRows = result.rows
        if (!beforeRows.length) {
          await client.query('COMMIT')
          committed = true
          return
        }
        await lockFileSyncPaths(client, ownerId, beforeRows.map((file) => file.storage_key))
        for (const before of beforeRows) {
          const sourcePath = (await safePath(options.storageRoot, before.storage_key)).target
          const destinationKey = await availableTrashKey(
            client, options.storageRoot, ownerId,
            trashKey(ownerId, before.storage_key, before.display_name, before.ext), before.display_name, before.ext,
          )
          const destinationPath = (await safePath(options.storageRoot, destinationKey)).target
          await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 })
          await rename(sourcePath, destinationPath)
          movedFiles.push({ sourcePath, destinationPath })
          const updated = await client.query<FileRow>(
            `UPDATE files SET storage_key=$3,deleted_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP
             WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING *`,
            [before.id, ownerId, destinationKey],
          )
          if (!updated.rows[0]) throw new CoreError('not_found', '文件不存在')
        }
        const current = await client.query<FileRow>(
          'SELECT * FROM files WHERE id=ANY($1::integer[]) AND user_id=$2 ORDER BY id',
          [beforeRows.map((file) => Number(file.id)), ownerId],
        )
        await recordBatchDeleteUndo(client, ownerId, undoContextId, beforeRows, current.rows)
        await client.query('COMMIT')
        committed = true
        changedIds = beforeRows.map((file) => Number(file.id))
      } catch (error) {
        if (!committed) {
          await client.query('ROLLBACK').catch(() => undefined)
          for (const move of movedFiles.reverse()) {
            await mkdir(path.dirname(move.sourcePath), { recursive: true, mode: 0o700 }).catch(() => undefined)
            await rename(move.destinationPath, move.sourcePath).catch(() => undefined)
          }
        }
        throw error
      } finally {
        client.release()
      }
      for (const entityId of changedIds)
        await options.publishChanged({ ownerId, entityId, origin: clientId }).catch(() => undefined)
    },
  }
}
