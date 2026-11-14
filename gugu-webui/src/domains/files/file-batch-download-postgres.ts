import JSZip from 'jszip'
import { CoreError } from '@gugu/core'
import type { Pool, QueryResultRow } from 'pg'
import type { FileBatchDownloadOperations } from './file-batch-download.js'
import type { FolderDownloadOperations } from './folder-download.js'
import { normalizeFileOwnerId } from './file-owner.js'
import { openOwnedLocalFile } from './file-reads-postgres.js'

interface BatchFolderRow extends QueryResultRow {
  id: number | string
  name: string
  parent_id: number | string | null
  relative_path: string[]
}

interface BatchFileRow extends QueryResultRow {
  id: number | string
  display_name: string
  ext: string
  storage_key: string
  mime_type: string | null
  folder_id: number | string | null
}

interface ArchiveEntry {
  key: string
  filename: string
  mimeType: string
}

function safeArchiveSegment(value: string): string {
  const safe = value.replace(/[\\/:*?"<>|\0]/g, '_')
  return safe && safe !== '.' && safe !== '..' ? safe : 'file'
}

function archivePath(path: string): string {
  return path.split('/').map(safeArchiveSegment).join('/')
}

function uniqueName(input: string, counts: Map<string, number>): string {
  const count = counts.get(input) ?? 0
  counts.set(input, count + 1)
  if (count === 0) return input
  const index = input.lastIndexOf('.')
  const stem = index > 0 ? input.slice(0, index) : input
  const extension = index > 0 ? input.slice(index) : ''
  return `${stem}_${count}${extension}`
}

function filename(file: BatchFileRow): string {
  return safeArchiveSegment(`${file.display_name}.${file.ext.toLowerCase()}`)
}

async function generateArchive(entries: ArchiveEntry[], ownerId: string, storageRoot: string): Promise<Buffer> {
  const archive = new JSZip()
  const names = new Map<string, number>()
  for (const entry of entries) {
    const name = uniqueName(entry.filename, names)
    archive.file(name, await readOwnedContent(storageRoot, ownerId, entry.key, entry.filename, entry.mimeType))
  }
  return archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function loadFiles(
  pool: Pool,
  ownerId: string,
  ids: number[],
  field: 'id' | 'folder_id',
): Promise<BatchFileRow[]> {
  if (!ids.length) return []
  const result = await pool.query<BatchFileRow>(
    `SELECT id,display_name,ext,storage_key,mime_type,folder_id FROM files
     WHERE ${field}=ANY($1::integer[]) AND user_id=$2 AND deleted_at IS NULL ORDER BY id`,
    [ids, ownerId],
  )
  return result.rows
}

async function loadFolders(pool: Pool, ownerId: string, folderIds: number[]): Promise<BatchFolderRow[]> {
  if (!folderIds.length) return []
  const result = await pool.query<BatchFolderRow>(
    `WITH RECURSIVE folder_tree AS (
       SELECT id,parent_id,name,ARRAY[name]::text[] AS relative_path,0 AS depth
       FROM folders WHERE id=ANY($1::integer[]) AND user_id=$2 AND deleted_at IS NULL
       UNION ALL
       SELECT child.id,child.parent_id,child.name,folder_tree.relative_path || child.name,folder_tree.depth+1
       FROM folders child JOIN folder_tree ON child.parent_id=folder_tree.id
       WHERE child.user_id=$2 AND child.deleted_at IS NULL AND folder_tree.depth<64
     )
     SELECT id,parent_id,name,relative_path FROM folder_tree ORDER BY relative_path,id`,
    [folderIds, ownerId],
  )
  return result.rows
}

async function readOwnedContent(
  root: string, ownerId: string, storageKey: string, fileName: string, mimeType: string,
): Promise<Buffer> {
  const opened = await openOwnedLocalFile(
    root, ownerId, storageKey, null, fileName, mimeType || 'application/octet-stream',
  )
  if (!opened) throw new CoreError('not_found', '物理文件丢失')
  try { return await opened.handle.readFile() } finally { await opened.handle.close() }
}

export function createPostgresFileBatchDownloadOperations(
  pool: Pool,
  storageRoot: string,
): FileBatchDownloadOperations & FolderDownloadOperations {
  return {
    async build(rawOwnerId, fileIds, folderIds) {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      if (!fileIds.length && !folderIds.length)
        throw Object.assign(new Error('未选择文件'), { statusCode: 400 })

      const [files, folders] = await Promise.all([
        loadFiles(pool, ownerId, fileIds, 'id'),
        loadFolders(pool, ownerId, folderIds),
      ])
      const folderFiles = await loadFiles(pool, ownerId, folders.map((folder) => Number(folder.id)), 'folder_id')
      const folderPaths = new Map(folders.map((folder) => [Number(folder.id), folder.relative_path.map(safeArchiveSegment).join('/')]))
      const entries: ArchiveEntry[] = [
        ...files.map((file) => ({ key: file.storage_key, filename: filename(file), mimeType: file.mime_type || 'application/octet-stream' })),
        ...folderFiles.map((file) => ({
          key: file.storage_key,
          filename: archivePath(`${folderPaths.get(Number(file.folder_id)) ?? ''}/${filename(file)}`),
          mimeType: file.mime_type || 'application/octet-stream',
        })),
      ]
      if (!entries.length) throw new CoreError('not_found', '未找到可下载的文件')
      return generateArchive(entries, ownerId, storageRoot)
    },

    async buildFolder(rawOwnerId, folderId) {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      const root = await pool.query<QueryResultRow & { id: number | string; name: string }>(
        `SELECT id,name FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
        [folderId, ownerId],
      )
      const folder = root.rows[0]
      if (!folder) return null
      const folders = await loadFolders(pool, ownerId, [folderId])
      const files = await loadFiles(pool, ownerId, folders.map((item) => Number(item.id)), 'folder_id')
      const folderPaths = new Map(folders.map((item) => [Number(item.id), item.relative_path.map(safeArchiveSegment).join('/')]))
      const entries = files.map((file) => ({
        key: file.storage_key,
        filename: archivePath(`${folderPaths.get(Number(file.folder_id)) ?? ''}/${filename(file)}`),
        mimeType: file.mime_type || 'application/octet-stream',
      }))
      return {
        bytes: await generateArchive(entries, ownerId, storageRoot),
        folderName: String(folder.name),
      }
    },
  }
}
