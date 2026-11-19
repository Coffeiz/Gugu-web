import { buildOriginalKey } from '@gugu/core/project-file-paths'
import { CoreError } from '@gugu/core'
import { link, lstat, mkdir, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { isPathWithin } from '../../shared/path-safety.js'
import { normalizeFileOwnerId } from './file-owner.js'
import type { FileRestoreOperations } from './file-restore.js'

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
  created_at: Date | string
  deleted_at: Date | string | null
}

interface FolderRow extends QueryResultRow {
  id: number | string
  project_id: number | string | null
  workspace_directory_id: number | string | null
  parent_id: number | string | null
  name: string
  deleted_at: Date | string | null
  depth: number
  deleted_stamp: string
  version: number | string
}

class RestoreStoragePathError extends Error {}

function safeName(value: string): string { return value.replace(/[\\/:*?"<>|]/g, '_') }

function safeKey(ownerId: string, key: string): string[] {
  const parts = key.split('/')
  if (parts[0] !== ownerId || parts.length < 2
    || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')))
    throw new RestoreStoragePathError('文件存储位置无效')
  return parts
}

async function checkedPath(root: string, ownerId: string, key: string): Promise<string> {
  const parts = safeKey(ownerId, key)
  const target = path.resolve(root, ...parts)
  if (!isPathWithin(root, target)) throw new RestoreStoragePathError('文件存储位置无效')
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new RestoreStoragePathError('文件存储路径不能经过符号链接')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR')
        throw error
    }
  }
  return target
}

function withConflictName(baseKey: string, displayName: string, ext: string, suffix: number) {
  const name = `${displayName}(${suffix})`
  const filename = `${safeName(name)}${ext ? `.${ext.toLowerCase()}` : ''}`
  return { key: `${baseKey.slice(0, baseKey.lastIndexOf('/') + 1)}${filename}`, name }
}

async function removeMatchingLink(keep: string, remove: string): Promise<void> {
  try {
    const [kept, removed] = await Promise.all([lstat(keep), lstat(remove)])
    if (kept.isFile() && removed.isFile() && kept.dev === removed.dev && kept.ino === removed.ino) {
      await unlink(remove)
      return
    }
    console.error('文件恢复清理遇到路径变化，可能存在残留')
  } catch {
    console.error('文件恢复清理失败，可能存在残留')
  }
}

async function originalStorageKey(client: PoolClient, ownerId: string, file: FileRow): Promise<string> {
  let projectName = ''
  let projectDate = ''
  if (file.project_id !== null) {
    const project = await client.query<QueryResultRow & { name: string; start_date: string | null; created_at: Date | string }>(
      `SELECT name,start_date::text AS start_date,created_at FROM projects WHERE id=$1 AND user_id=$2 LIMIT 1`,
      [file.project_id, ownerId],
    )
    const row = project.rows[0]
    if (row) {
      projectName = row.name
      projectDate = row.start_date ?? (row.created_at instanceof Date
        ? row.created_at.toISOString().slice(0, 10) : String(row.created_at).slice(0, 10))
    }
  }

  let folderPath = ''
  if (file.folder_id !== null) {
    const result = await client.query<FolderRow>(
      `WITH RECURSIVE chain AS (
         SELECT id,parent_id,name,ARRAY[id]::integer[] AS visited,0 AS depth
         FROM folders WHERE id=$1 AND user_id=$2
           AND project_id IS NOT DISTINCT FROM $3::integer
           AND workspace_directory_id IS NOT DISTINCT FROM $4::integer
         UNION ALL
         SELECT parent.id,parent.parent_id,parent.name,chain.visited || parent.id,chain.depth+1
         FROM folders AS parent JOIN chain ON parent.id=chain.parent_id
         WHERE parent.user_id=$2
           AND parent.project_id IS NOT DISTINCT FROM $3::integer
           AND parent.workspace_directory_id IS NOT DISTINCT FROM $4::integer
           AND NOT parent.id=ANY(chain.visited)
       )
       SELECT name,parent_id FROM chain ORDER BY depth DESC`,
      [file.folder_id, ownerId, file.project_id, file.workspace_directory_id],
    )
    const rows = result.rows
    if (rows.length && rows[0]?.parent_id === null)
      folderPath = rows.map((row) => safeName(row.name)).join('/')
  }

  let workspaceName = ''
  if (file.workspace_directory_id !== null) {
    const result = await client.query<QueryResultRow & { directory_name: string; deleted_at: Date | string | null }>(
      'SELECT directory_name,deleted_at FROM workspace_directories WHERE id=$1 AND user_id=$2 LIMIT 1',
      [file.workspace_directory_id, ownerId],
    )
    const row = result.rows[0]
    if (!row || row.deleted_at !== null) throw new CoreError('conflict', '工作区目录不存在，无法恢复文件')
    workspaceName = row.directory_name
    if (!workspaceName || workspaceName === '.' || workspaceName === '..' || safeName(workspaceName) !== workspaceName)
      throw new CoreError('invalid_request', '工作区目录名无效')
  }

  let mindMapTitle = ''
  if (file.mind_map_id !== null) {
    const result = await client.query<QueryResultRow & { title: string }>(
      'SELECT title FROM mind_maps WHERE id=$1 AND user_id=$2 LIMIT 1', [file.mind_map_id, ownerId],
    )
    mindMapTitle = result.rows[0]?.title ?? ''
  }

  return buildOriginalKey(ownerId, file, {
    projectName, projectDate, projectId: Number(file.project_id ?? 0), folderPath,
    mindMapTitle, mindMapId: Number(file.mind_map_id ?? 0), workspaceDirectoryName: workspaceName,
  })
}

async function restoreLocalFile(
  rootPath: string,
  ownerId: string,
  file: FileRow,
  baseKey: string,
  createLink: typeof link = link,
): Promise<{ storageKey: string; displayName: string; movedFrom: string | null; movedTo: string | null }> {
  const root = await realpath(rootPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!root || file.storage_key === baseKey)
    return { storageKey: baseKey, displayName: file.display_name, movedFrom: null, movedTo: null }

  let available = { key: baseKey, name: file.display_name }
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? available : withConflictName(baseKey, file.display_name, file.ext, suffix - 1)
    const target = await checkedPath(root, ownerId, candidate.key)
    try {
      await lstat(target)
      available = withConflictName(baseKey, file.display_name, file.ext, suffix)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') { available = candidate; break }
      throw error
    }
  }

  const source = await checkedPath(root, ownerId, file.storage_key)
  try {
    for (let suffix = 1; ; suffix += 1) {
      const destination = await checkedPath(root, ownerId, available.key)
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      try { await createLink(source, destination) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        available = withConflictName(baseKey, file.display_name, file.ext, suffix)
        continue
      }
      try {
        if (!(await lstat(destination)).isFile()) throw new RestoreStoragePathError('恢复文件类型无效')
        const resolved = await realpath(destination)
        if (!isPathWithin(root, resolved)) throw new RestoreStoragePathError('恢复后的文件超出存储根目录')
      } catch (error) {
        await unlink(destination).catch(() => undefined)
        if (error instanceof RestoreStoragePathError) throw error
        throw new CoreError('storage_error', '文件恢复未完成')
      }
      return { storageKey: available.key, displayName: available.name, movedFrom: source, movedTo: destination }
    }
  } catch (error) {
    if (error instanceof RestoreStoragePathError || error instanceof CoreError) throw error
    if (['EXDEV', 'EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'EMLINK'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw new CoreError('storage_error', '文件存储不支持安全恢复')
    // Python 回收站恢复会在物理文件缺失或搬移失败时仍恢复数据库墓碑。
    return { storageKey: available.key, displayName: available.name, movedFrom: null, movedTo: null }
  }
}

export function createPostgresFileRestoreOperations(
  pool: Pool,
  options: {
    storageRoot: string
    createRestoreLink?: typeof link
    publishChanged(event: { ownerId: string; entityId: number; origin?: string | null; entityType?: 'file' | 'folder' }): Promise<void>
  },
): FileRestoreOperations {
  return {
    async restore(rawOwnerId, fileId, origin = null) {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      if (!Number.isSafeInteger(fileId) || fileId < 1) throw new CoreError('invalid_request', '文件 ID 无效')
      const client = await pool.connect()
      let committed = false
      let commitAttempted = false
      let movedFrom: string | null = null
      let movedTo: string | null = null
      try {
        await client.query('BEGIN')
        const found = await client.query<FileRow>(
          'SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NOT NULL FOR UPDATE', [fileId, ownerId],
        )
        const file = found.rows[0]
        if (!file) throw new CoreError('not_found', '文件不存在')
        if (file.folder_id !== null) {
          const folder = await client.query<QueryResultRow & { deleted_at: Date | string | null }>(
            'SELECT deleted_at FROM folders WHERE id=$1 AND user_id=$2 LIMIT 1', [file.folder_id, ownerId],
          )
          if (!folder.rows[0] || folder.rows[0].deleted_at !== null)
            throw new CoreError('conflict', '所属文件夹仍在回收站，请先恢复文件夹')
        }
        const baseKey = await originalStorageKey(client, ownerId, file)
        const restored = await restoreLocalFile(options.storageRoot, ownerId, file, baseKey, options.createRestoreLink)
        movedFrom = restored.movedFrom
        movedTo = restored.movedTo
        const updated = await client.query(
          `UPDATE files SET storage_key=$3,display_name=$4,deleted_at=NULL,updated_at=CURRENT_TIMESTAMP
           WHERE id=$1 AND user_id=$2 AND deleted_at IS NOT NULL RETURNING id`,
          [fileId, ownerId, restored.storageKey, restored.displayName],
        )
        if (!updated.rows[0]) throw new CoreError('not_found', '文件不存在')
        commitAttempted = true
        await client.query('COMMIT')
        committed = true
        if (movedFrom && movedTo) await removeMatchingLink(movedTo, movedFrom)
      } catch (error) {
        if (!committed) {
          await client.query('ROLLBACK').catch(() => undefined)
          if (!commitAttempted && movedFrom && movedTo) await removeMatchingLink(movedFrom, movedTo)
          if (commitAttempted) console.error('文件恢复提交结果未知，保留两处文件供核查')
        }
        throw error
      } finally {
        client.release()
      }
      await options.publishChanged({ ownerId, entityId: fileId, origin, entityType: 'file' }).catch(() => undefined)
    },

    async restoreBatch(rawOwnerId, rawFileIds, origin = null) {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      if (!Array.isArray(rawFileIds) || rawFileIds.some((id) => !Number.isSafeInteger(id) || id < 1))
        throw new CoreError('invalid_request', '文件 ID 列表无效')
      if (!rawFileIds.length) return
      const client = await pool.connect()
      const moved: Array<{ from: string; to: string }> = []
      let committed = false
      let commitAttempted = false
      const restoredFiles: number[] = []
      try {
        await client.query('BEGIN')
        const found = await client.query<FileRow>(
          `SELECT * FROM files WHERE id=ANY($1::integer[]) AND user_id=$2 AND deleted_at IS NOT NULL
           ORDER BY id FOR UPDATE`, [rawFileIds, ownerId],
        )
        const files = found.rows
        for (const file of files) {
          if (file.folder_id === null) continue
          const folder = await client.query<QueryResultRow & { deleted_at: Date | string | null }>(
            'SELECT deleted_at FROM folders WHERE id=$1 AND user_id=$2 LIMIT 1', [file.folder_id, ownerId],
          )
          if (!folder.rows[0] || folder.rows[0].deleted_at !== null)
            throw new CoreError('conflict', '所属文件夹仍在回收站，请先恢复文件夹')
        }
        for (const file of files) {
          const baseKey = await originalStorageKey(client, ownerId, file)
          const restored = await restoreLocalFile(options.storageRoot, ownerId, file, baseKey, options.createRestoreLink)
          if (restored.movedFrom && restored.movedTo)
            moved.push({ from: restored.movedFrom, to: restored.movedTo })
          const updated = await client.query(
            `UPDATE files SET storage_key=$3,display_name=$4,deleted_at=NULL,updated_at=CURRENT_TIMESTAMP
             WHERE id=$1 AND user_id=$2 AND deleted_at IS NOT NULL RETURNING id`,
            [file.id, ownerId, restored.storageKey, restored.displayName],
          )
          if (!updated.rows[0]) throw new CoreError('not_found', '文件不存在')
          restoredFiles.push(Number(file.id))
        }
        commitAttempted = true
        await client.query('COMMIT')
        committed = true
        for (const move of moved) await removeMatchingLink(move.to, move.from)
      } catch (error) {
        if (!committed) {
          await client.query('ROLLBACK').catch(() => undefined)
          if (!commitAttempted) for (const move of moved.reverse()) await removeMatchingLink(move.from, move.to)
          if (commitAttempted) console.error('文件批量恢复提交结果未知，保留两处文件供核查')
        }
        throw error
      } finally {
        client.release()
      }
      for (const entityId of restoredFiles)
        await options.publishChanged({ ownerId, entityId, origin, entityType: 'file' }).catch(() => undefined)
    },

    async restoreFolder(rawOwnerId, folderId, origin = null) {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      if (!Number.isSafeInteger(folderId) || folderId < 1) throw new CoreError('invalid_request', '文件夹 ID 无效')
      const client = await pool.connect()
      const moved: Array<{ from: string; to: string }> = []
      let committed = false
      let commitAttempted = false
      let root: FolderRow | undefined
      let restoredFiles: number[] = []
      try {
        await client.query('BEGIN')
        const rootResult = await client.query<FolderRow>(
          `SELECT folder.id,folder.project_id,folder.workspace_directory_id,folder.parent_id,folder.name,
             folder.deleted_at,folder.version,0 AS depth,
             to_char(folder.deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00' AS deleted_stamp
           FROM folders folder LEFT JOIN folders parent ON parent.id=folder.parent_id
           WHERE folder.id=$1 AND folder.user_id=$2 AND folder.deleted_at IS NOT NULL
             AND (folder.parent_id IS NULL OR parent.deleted_at IS NULL)
           FOR UPDATE OF folder`, [folderId, ownerId],
        )
        root = rootResult.rows[0]
        if (!root) throw new CoreError('not_found', '文件夹不存在')
        const deletedStamp = root.deleted_stamp
        const tree = await client.query<FolderRow>(
          `WITH RECURSIVE descendants AS (
             SELECT id,project_id,workspace_directory_id,parent_id,name,deleted_at,0 AS depth
             FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at=$3::timestamptz
             UNION ALL
             SELECT child.id,child.project_id,child.workspace_directory_id,child.parent_id,child.name,child.deleted_at,descendants.depth+1
             FROM folders child JOIN descendants ON child.parent_id=descendants.id
             WHERE child.user_id=$2 AND child.deleted_at=descendants.deleted_at AND descendants.depth<64
           ) SELECT descendants.*,to_char(descendants.deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00' AS deleted_stamp
             FROM descendants ORDER BY depth,id`, [folderId, ownerId, deletedStamp],
        )
        const folders = tree.rows
        const folderIds = folders.map((folder) => Number(folder.id))
        await client.query('SELECT id FROM folders WHERE id=ANY($1::integer[]) AND user_id=$2 FOR UPDATE', [folderIds, ownerId])

        for (const folder of folders) {
          let restoredName = folder.name
          for (let suffix = 1; ; suffix += 1) {
            const collision = await client.query(
              `SELECT 1 FROM folders WHERE user_id=$1 AND project_id IS NOT DISTINCT FROM $2::integer
                 AND workspace_directory_id IS NOT DISTINCT FROM $3::integer
                 AND parent_id IS NOT DISTINCT FROM $4::integer AND name=$5 AND deleted_at IS NULL LIMIT 1`,
              [ownerId, folder.project_id, folder.workspace_directory_id, folder.parent_id, restoredName],
            )
            if (!collision.rowCount) break
            const marker = `(${suffix})`
            restoredName = `${folder.name.slice(0, 200 - marker.length)}${marker}`
          }
          const updated = await client.query<FolderRow>(
            `UPDATE folders SET name=$3,deleted_at=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP
             WHERE id=$1 AND user_id=$2 AND deleted_at=$4::timestamptz
             RETURNING id,project_id,workspace_directory_id,parent_id,name,deleted_at,version,0 AS depth,NULL::text AS deleted_stamp`,
            [folder.id, ownerId, restoredName, deletedStamp],
          )
          if (!updated.rows[0]) throw new CoreError('not_found', '文件夹不存在')
          if (Number(folder.id) === folderId) root = updated.rows[0]
        }

        const files = await client.query<FileRow>(
          `SELECT * FROM files WHERE user_id=$1 AND folder_id=ANY($2::integer[])
             AND deleted_at=$3::timestamptz ORDER BY folder_id,id FOR UPDATE`,
          [ownerId, folderIds, deletedStamp],
        )
        for (const file of files.rows) {
          const baseKey = await originalStorageKey(client, ownerId, file)
          const restored = await restoreLocalFile(options.storageRoot, ownerId, file, baseKey, options.createRestoreLink)
          if (restored.movedFrom && restored.movedTo) moved.push({ from: restored.movedFrom, to: restored.movedTo })
          const updated = await client.query(
            `UPDATE files SET storage_key=$3,display_name=$4,deleted_at=NULL,updated_at=CURRENT_TIMESTAMP
             WHERE id=$1 AND user_id=$2 AND deleted_at=$5::timestamptz RETURNING id`,
            [file.id, ownerId, restored.storageKey, restored.displayName, deletedStamp],
          )
          if (!updated.rows[0]) throw new CoreError('not_found', '文件不存在')
          restoredFiles.push(Number(file.id))
        }
        commitAttempted = true
        await client.query('COMMIT')
        committed = true
        for (const move of moved) await removeMatchingLink(move.to, move.from)
      } catch (error) {
        if (!committed) {
          await client.query('ROLLBACK').catch(() => undefined)
          if (!commitAttempted) for (const move of moved.reverse()) await removeMatchingLink(move.from, move.to)
          if (commitAttempted) console.error('文件夹恢复提交结果未知，保留两处文件供核查')
        }
        throw error
      } finally {
        client.release()
      }
      for (const entityId of restoredFiles)
        await options.publishChanged({ ownerId, entityId, origin, entityType: 'file' }).catch(() => undefined)
      await options.publishChanged({ ownerId, entityId: folderId, origin, entityType: 'folder' }).catch(() => undefined)
      return {
        id: Number(root!.id), project_id: root!.project_id === null ? null : Number(root!.project_id),
        workspace_directory_id: root!.workspace_directory_id === null ? null : Number(root!.workspace_directory_id),
        parent_id: root!.parent_id === null ? null : Number(root!.parent_id), name: root!.name,
        file_count: 0, folder_count: 0, version: Number(root!.version ?? 1),
      }
    },
  }
}
