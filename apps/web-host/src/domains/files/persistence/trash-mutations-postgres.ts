import { CoreError } from '@gugu/core'
import { randomUUID } from 'node:crypto'
import { lstat, readdir, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { isPathWithin } from '../../../adapters/path-safety.js'
import { normalizeFileOwnerId } from '../file-owner.js'
import type { TrashOperations } from '../trash.js'

interface DeletedFileRow extends QueryResultRow {
  id: number | string
  storage_key: string
  size_bytes: number | string
}

interface QuotaRow extends QueryResultRow {
  used_bytes: number | string
}

export interface TrashMutationEvent {
  ownerId: string
  entityId: number
  entityType: 'file' | 'folder'
  origin: string | null
}

async function removeLocalFile(storageRoot: string, ownerId: string, key: string): Promise<boolean> {
  const segments = key.split('/')
  if (segments[0] !== ownerId || segments.length < 2
    || segments.some((segment) => !segment || segment === '.' || segment === '..'
      || segment.includes('\\') || segment.includes('\0')))
    throw new Error('invalid local file key')
  const root = await realpath(storageRoot)
  let current = root
  for (const segment of segments) {
    current = path.join(current, segment)
    if (!isPathWithin(root, current)) throw new Error('local file path escaped storage root')
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('local file path traverses symlink')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return false
      throw error
    }
  }
  await unlink(current)
  return true
}

async function lockQuota(client: PoolClient, ownerId: string): Promise<number> {
  const result = await client.query<QuotaRow>(
    `SELECT used_bytes FROM storage_quota_ledgers
     WHERE user_id=$1 AND category='file_library' AND status='active' FOR UPDATE`, [ownerId],
  )
  const row = result.rows[0]
  if (!row) throw new CoreError('busy', '存储配额账本尚未就绪，请稍后重试')
  return Number(row.used_bytes)
}

async function measureDirectory(storageRoot: string, root: string): Promise<number> {
  let total = 0
  let current = storageRoot
  for (const part of path.relative(storageRoot, root).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) return 0
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return 0
      throw error
    }
  }
  const visit = async (directory: string): Promise<void> => {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return
      throw error
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      let info
      try { info = await lstat(target) }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') continue
        throw error
      }
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) await visit(target)
      else if (info.isFile()) total += info.size
    }
  }
  await visit(root)
  return total
}

async function reconcileLocalUsage(
  client: PoolClient,
  storageRoot: string,
  ownerId: string,
  usedBytes: number,
): Promise<number> {
  const root = await realpath(storageRoot)
  const roots = [
    path.join(root, ownerId, 'workspace'),
    path.join(root, ownerId, '个人文件'),
    path.join(root, ownerId, '项目文件'),
    path.join(root, ownerId, 'trash'),
    path.join(root, ownerId.replaceAll('-', ''), '.data-portability', 'imported'),
  ]
  const sizes = await Promise.all(roots.map((directory) => measureDirectory(root, directory)))
  const measured = sizes.reduce((sum, size) => sum + size, 0)
  const delta = measured - usedBytes
  if (delta !== 0) {
    await client.query(
      `INSERT INTO storage_quota_events
         (user_id,category,operation,delta_bytes,resource_type,resource_id,idempotency_key,metadata_json,created_at)
       VALUES ($1,'file_library','reconcile',$2,'quota','file_library',$3,$4::jsonb,CURRENT_TIMESTAMP)`,
      [ownerId, delta, `trash-reconcile:${ownerId}:${randomUUID()}`, JSON.stringify({ measured_bytes: measured })],
    )
  }
  await client.query(
    `UPDATE storage_quota_ledgers SET used_bytes=$3,last_reconciled_at=CURRENT_TIMESTAMP,
       updated_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND category='file_library' AND status='active'`,
    [ownerId, 'file_library', measured],
  )
  return measured
}

async function releaseQuota(
  client: PoolClient,
  ownerId: string,
  fileId: number,
  sizeBytes: number,
  usedBytes: number,
): Promise<number> {
  const released = Math.min(Math.max(0, sizeBytes), Math.max(0, usedBytes))
  if (released <= 0) return usedBytes
  await client.query(
    `INSERT INTO storage_quota_events
       (user_id,category,operation,delta_bytes,resource_type,resource_id,idempotency_key,metadata_json,created_at)
     VALUES ($1,'file_library','trash_permanent_delete',$2,'file',$3,$4,NULL,CURRENT_TIMESTAMP)`,
    [ownerId, -released, String(fileId), `trash-permanent-delete:${fileId}`],
  )
  await client.query(
    `UPDATE storage_quota_ledgers SET used_bytes=$3,updated_at=CURRENT_TIMESTAMP
     WHERE user_id=$1 AND category=$2 AND status='active'`,
    [ownerId, 'file_library', usedBytes - released],
  )
  return usedBytes - released
}

export function createPostgresTrashMutationOperations(
  pool: Pool,
  options: {
    storageRoot: string
    publishChanged(event: TrashMutationEvent): Promise<void>
  },
): Pick<TrashOperations, 'hardDeleteFile' | 'hardDeleteFolder'> {
  return {
    async hardDeleteFile(rawOwner, fileId, origin) {
      const ownerId = normalizeFileOwnerId(rawOwner)
      if (!Number.isSafeInteger(fileId) || fileId < 1) throw new CoreError('invalid_request', '文件 ID 无效')
      const client = await pool.connect()
      let committed = false
      let fileDeleted = false
      try {
        await client.query('BEGIN')
        const found = await client.query<DeletedFileRow>(
          `SELECT id,storage_key,size_bytes FROM files
           WHERE id=$1 AND user_id=$2 AND deleted_at IS NOT NULL FOR UPDATE`, [fileId, ownerId],
        )
        const file = found.rows[0]
        if (!file) throw new CoreError('not_found', '文件不存在')
        let quota = Number(file.size_bytes) > 0 ? await lockQuota(client, ownerId) : null
        if (quota !== null && quota < Number(file.size_bytes))
          quota = await reconcileLocalUsage(client, options.storageRoot, ownerId, quota)
        let deletedFromStorage = false
        try { deletedFromStorage = await removeLocalFile(options.storageRoot, ownerId, file.storage_key) }
        catch { /* Python 同样在物理删除失败时清除数据库墓碑，避免坏对象阻塞回收站。 */ }
        if (deletedFromStorage && quota !== null)
          await releaseQuota(client, ownerId, fileId, Number(file.size_bytes), quota)
        await client.query('DELETE FROM files WHERE id=$1 AND user_id=$2', [fileId, ownerId])
        await client.query('COMMIT')
        committed = true
        fileDeleted = true
      } catch (error) {
        if (!committed) await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
      if (fileDeleted)
        await options.publishChanged({ ownerId, entityId: fileId, entityType: 'file', origin }).catch(() => undefined)
    },

    async hardDeleteFolder(rawOwner, folderId, origin) {
      const ownerId = normalizeFileOwnerId(rawOwner)
      if (!Number.isSafeInteger(folderId) || folderId < 1) throw new CoreError('invalid_request', '文件夹 ID 无效')
      const client = await pool.connect()
      let committed = false
      let folderIds: number[] = []
      let deletedFileIds: number[] = []
      try {
        await client.query('BEGIN')
        const root = await client.query<{ id: number | string }>(
          `SELECT folder.id FROM folders folder LEFT JOIN folders parent ON parent.id=folder.parent_id
           WHERE folder.id=$1 AND folder.user_id=$2 AND folder.deleted_at IS NOT NULL
             AND (folder.parent_id IS NULL OR parent.deleted_at IS NULL) FOR UPDATE OF folder`,
          [folderId, ownerId],
        )
        if (!root.rowCount) throw new CoreError('not_found', '文件夹不存在')
        const tree = await client.query<{ id: number | string }>(
          `WITH RECURSIVE descendants AS (
             SELECT id FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NOT NULL
             UNION ALL
             SELECT child.id FROM folders child JOIN descendants parent ON child.parent_id=parent.id
             WHERE child.user_id=$2 AND child.deleted_at IS NOT NULL
           ) SELECT id FROM descendants`, [folderId, ownerId],
        )
        folderIds = [...new Set(tree.rows.map((row) => Number(row.id)))]
        const files = await client.query<DeletedFileRow>(
          `SELECT id,storage_key,size_bytes FROM files
           WHERE user_id=$1 AND folder_id=ANY($2::integer[]) AND deleted_at IS NOT NULL
           ORDER BY id FOR UPDATE`, [ownerId, folderIds],
        )
        deletedFileIds = files.rows.map((file) => Number(file.id))
        const needsQuota = files.rows.some((file) => Number(file.size_bytes) > 0)
        let usedBytes = needsQuota ? await lockQuota(client, ownerId) : 0
        const largestFile = files.rows.reduce((largest, file) => Math.max(largest, Number(file.size_bytes) || 0), 0)
        if (needsQuota && usedBytes < largestFile)
          usedBytes = await reconcileLocalUsage(client, options.storageRoot, ownerId, usedBytes)
        for (const file of files.rows) {
          let deletedFromStorage = false
          try { deletedFromStorage = await removeLocalFile(options.storageRoot, ownerId, file.storage_key) }
          catch { /* 清理墓碑与 Python 一致，即使对象已缺失或不可访问。 */ }
          if (deletedFromStorage && Number(file.size_bytes) > 0) {
            usedBytes = await releaseQuota(client, ownerId, Number(file.id), Number(file.size_bytes), usedBytes)
          }
        }
        await client.query('DELETE FROM files WHERE user_id=$1 AND folder_id=ANY($2::integer[]) AND deleted_at IS NOT NULL', [ownerId, folderIds])
        await client.query('DELETE FROM folders WHERE user_id=$1 AND id=ANY($2::integer[]) AND deleted_at IS NOT NULL', [ownerId, folderIds])
        await client.query('COMMIT')
        committed = true
      } catch (error) {
        if (!committed) await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
      for (const entityId of deletedFileIds)
        await options.publishChanged({ ownerId, entityId, entityType: 'file', origin }).catch(() => undefined)
      await options.publishChanged({ ownerId, entityId: folderId, entityType: 'folder', origin }).catch(() => undefined)
    },
  }
}
