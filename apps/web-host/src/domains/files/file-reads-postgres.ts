import { CoreError } from '@gugu/core'
import { openLocalFile, UnsafeLocalPathError } from '@gugu/fs/node'
import type { Pool, QueryResultRow } from 'pg'
import type { FileContentSource, FileReadOperations } from './file-reads.js'

type FileRow = QueryResultRow & Record<string, unknown> & {
  id: number | string
  storage_key: string
  display_name: string
  ext: string
  space: string
  workspace_directory_id: number | string | null
  project_id: number | string | null
  project_name: string | null
  project_color: string | null
  stage_name: string
  folder_id: number | string | null
  folder_name: string | null
  mind_map_id: number | string | null
  size: string
  size_bytes: number | string
  mime_type: string | null
  created_at: string | Date
  deleted_at: string | Date | null
  img_width: number | string | null
  img_height: number | string | null
  version: number | string | null
}

type FolderRow = QueryResultRow & {
  id: number | string
  project_id: number | string | null
  workspace_directory_id: number | string | null
  parent_id: number | string | null
  name: string
  version: number | string | null
}

function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value)
}

function colorValue(raw: string | null): string | null {
  if (!raw) return null
  return raw.match(/#[0-9a-fA-F]{3,6}/)?.[0] ?? raw
}

function relativePathParts(pathValue: string): string[] | null {
  let decoded: string
  try { decoded = decodeURIComponent(pathValue) } catch { return null }
  const logicalPath = decoded.split(/[?#]/, 1)[0] ?? ''
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(decoded) || decoded.startsWith('//')
    || logicalPath.startsWith('/') || logicalPath.startsWith('\\')
    || logicalPath.includes('\\') || logicalPath.includes('\0')) return null
  const parts = logicalPath.split('/').filter((part) => part !== '' && part !== '.')
  return parts.length ? parts : null
}

async function sourceFolderPath(pool: Pool, ownerId: string, file: FileRow): Promise<FolderRow[] | null> {
  if (file.folder_id === null) return []
  const result = await pool.query<FolderRow & { depth: number }>(
    `WITH RECURSIVE chain AS (
       SELECT id,project_id,workspace_directory_id,parent_id,name,version,0 AS depth
       FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
       UNION ALL
       SELECT parent.id,parent.project_id,parent.workspace_directory_id,parent.parent_id,parent.name,parent.version,child.depth+1
       FROM folders parent JOIN chain child ON child.parent_id=parent.id
       WHERE parent.user_id=$2 AND parent.deleted_at IS NULL AND child.depth<64
     )
     SELECT id,project_id,workspace_directory_id,parent_id,name,version,depth FROM chain ORDER BY depth DESC`,
    [file.folder_id, ownerId],
  )
  if (!result.rows.length || result.rows[0]!.parent_id !== null
    || result.rows.some((row) => !sameScope(row, file))) return null
  return result.rows
}

async function childFolder(
  pool: Pool, ownerId: string, file: FileRow, parentId: number | null, name: string,
): Promise<FolderRow | null> {
  const result = await pool.query<FolderRow>(
    `SELECT id,project_id,workspace_directory_id,parent_id,name,version FROM folders
     WHERE user_id=$1 AND deleted_at IS NULL AND parent_id IS NOT DISTINCT FROM $2
       AND project_id IS NOT DISTINCT FROM $3 AND workspace_directory_id IS NOT DISTINCT FROM $4
       AND name=$5 LIMIT 1`,
    [ownerId, parentId, file.project_id, file.workspace_directory_id, name],
  )
  return result.rows[0] ?? null
}

async function relativeFile(
  pool: Pool, ownerId: string, source: FileRow, parentId: number | null, basename: string,
): Promise<FileRow | null> {
  if (basename === '..') return null
  const dot = basename.lastIndexOf('.')
  const hasExtension = dot > 0
  const displayName = hasExtension ? basename.slice(0, dot) : basename
  const ext = hasExtension ? basename.slice(dot + 1).toUpperCase() : ''
  const result = await pool.query<FileRow>(
    `SELECT ${fileProjection} FROM files file
     LEFT JOIN projects project ON project.id=file.project_id AND project.user_id=file.user_id
     LEFT JOIN folders folder ON folder.id=file.folder_id AND folder.user_id=file.user_id
     WHERE file.user_id=$1 AND file.deleted_at IS NULL AND file.space=$2
       AND file.project_id IS NOT DISTINCT FROM $3
       AND file.workspace_directory_id IS NOT DISTINCT FROM $4
       AND file.mind_map_id IS NOT DISTINCT FROM $5
       AND file.folder_id IS NOT DISTINCT FROM $6 AND file.display_name=$7 AND file.ext=$8
     LIMIT 1`,
    [ownerId, source.space, source.project_id, source.workspace_directory_id, source.mind_map_id,
      parentId, displayName, ext],
  )
  return result.rows[0] ?? null
}

async function relativeFolder(
  pool: Pool, ownerId: string, source: FileRow, parentId: number | null, name: string,
): Promise<FolderRow | null> {
  if (name === '' || name === '.' || name === '..') return null
  return childFolder(pool, ownerId, source, parentId, name)
}

async function resolveRelativePath(
  pool: Pool, ownerId: string, source: FileRow, sourcePath: FolderRow[], originalPath: string,
): Promise<Record<string, unknown>> {
  const parts = relativePathParts(originalPath)
  if (!parts) return { path: originalPath, file: null, folder: null }
  const currentPath = [...sourcePath]
  for (const part of parts.slice(0, -1)) {
    if (part === '..') {
      if (!currentPath.length) return { path: originalPath, file: null, folder: null }
      currentPath.pop()
      continue
    }
    const folder = await childFolder(pool, ownerId, source, currentPath.at(-1) ? Number(currentPath.at(-1)!.id) : null, part)
    if (!folder) return { path: originalPath, file: null, folder: null }
    currentPath.push(folder)
  }
  const parentId = currentPath.at(-1) ? Number(currentPath.at(-1)!.id) : null
  const basename = parts.at(-1)!
  const file = await relativeFile(pool, ownerId, source, parentId, basename)
  const folder = file ? null : await relativeFolder(pool, ownerId, source, parentId, basename)
  return {
    path: originalPath,
    file: file ? fileResponse(file) : null,
    folder: folder ? {
      id: Number(folder.id),
      projectId: nullableNumber(folder.project_id),
      workspaceDirectoryId: nullableNumber(folder.workspace_directory_id),
      parentId: nullableNumber(folder.parent_id),
      name: folder.name,
      fileCount: 0,
      folderCount: 0,
      version: Number(folder.version ?? 1),
    } : null,
  }
}

function isoUtc(raw: string | Date): string {
  const value = raw instanceof Date ? raw.toISOString() : raw
  return value.endsWith('Z') ? value : `${value}Z`
}

function fileResponse(row: FileRow) {
  return {
    id: Number(row.id),
    displayName: row.display_name,
    ext: row.ext,
    space: row.space,
    workspaceDirectoryId: nullableNumber(row.workspace_directory_id),
    projectId: nullableNumber(row.project_id),
    projectName: row.project_name,
    projectColor: colorValue(row.project_color),
    stageName: row.stage_name,
    folderId: nullableNumber(row.folder_id),
    folderName: row.folder_name,
    mindMapId: nullableNumber(row.mind_map_id),
    size: row.size,
    sizeBytes: Number(row.size_bytes),
    mimeType: row.mime_type,
    createdAt: isoUtc(row.created_at),
    deletedAt: row.deleted_at === null ? null : row.deleted_at instanceof Date
      ? row.deleted_at.toISOString().slice(0, 19)
      : row.deleted_at.replace(/[+-]\d\d:\d\d$/, '').replace(/Z$/, ''),
    imgWidth: nullableNumber(row.img_width),
    imgHeight: nullableNumber(row.img_height),
    version: Number(row.version ?? 1),
  }
}

const fileProjection = `file.id,file.display_name,file.ext,file.space,file.workspace_directory_id,
  file.storage_key,file.project_id,project.name AS project_name,project.color AS project_color,file.stage_name,
  file.folder_id,folder.name AS folder_name,file.mind_map_id,file.size,file.size_bytes,
  file.mime_type,to_char(file.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at,
  CASE WHEN file.deleted_at IS NULL THEN NULL ELSE to_char(file.deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') END AS deleted_at,
  file.img_width,file.img_height,file.version`

async function loadFile(pool: Pool, ownerId: string, fileId: number): Promise<FileRow | null> {
  const result = await pool.query<FileRow>(
    `SELECT ${fileProjection}
     FROM files file
     LEFT JOIN projects project ON project.id=file.project_id AND project.user_id=file.user_id
     LEFT JOIN folders folder ON folder.id=file.folder_id AND folder.user_id=file.user_id
     WHERE file.id=$1 AND file.user_id=$2 AND file.deleted_at IS NULL`,
    [fileId, ownerId],
  )
  return result.rows[0] ?? null
}

function sameScope(row: FolderRow, file: FileRow): boolean {
  return nullableNumber(row.project_id) === nullableNumber(file.project_id)
    && nullableNumber(row.workspace_directory_id) === nullableNumber(file.workspace_directory_id)
}

export async function openOwnedLocalFile(
  storageRoot: string,
  ownerId: string,
  storageKey: string,
  file: unknown,
  fileName: string,
  mimeType: string,
): Promise<FileContentSource | null> {
  const segments = storageKey.split('/')
  if (segments[0] !== ownerId || segments.some((segment) =>
    !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')))
    throw new CoreError('not_found', '文件不存在')

  try {
    const opened = await openLocalFile(storageRoot, storageKey)
    return opened ? { file, ...opened, fileName, mimeType } : null
  } catch (error) {
    if (error instanceof UnsafeLocalPathError) throw new CoreError('not_found', '文件不存在')
    throw error
  }
}

export function createPostgresFileReadOperations(
  pool: Pool,
  defaultStorageLimitBytes: number | null = null,
  storageRoot = '../Gugu-data/users',
): FileReadOperations {
  return {
    async getFile(ownerId, fileId) {
      const row = await loadFile(pool, ownerId, fileId)
      return row ? fileResponse(row) : null
    },

    async openContent(ownerId, fileId) {
      const row = await loadFile(pool, ownerId, fileId)
      if (!row) return null
      return openOwnedLocalFile(
        storageRoot,
        ownerId,
        row.storage_key,
        fileResponse(row),
        `${row.display_name}.${row.ext.toLowerCase()}`,
        row.mime_type || 'application/octet-stream',
      )
    },

    async getFileLocation(ownerId, fileId) {
      const file = await loadFile(pool, ownerId, fileId)
      if (!file) return null
      if (file.folder_id === null) return { file: fileResponse(file), folderPath: [] }

      let folderId: number | null = Number(file.folder_id)
      const seen = new Set<number>()
      const folders: FolderRow[] = []
      while (folderId !== null && folders.length < 64) {
        if (seen.has(folderId)) throw new CoreError('not_found', '文件位置不存在')
        seen.add(folderId)
        const result: { rows: FolderRow[] } = await pool.query<FolderRow>(
          `SELECT id,project_id,workspace_directory_id,parent_id,name,version
           FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
          [folderId, ownerId],
        )
        const folder: FolderRow | undefined = result.rows[0]
        if (!folder || !sameScope(folder, file)) throw new CoreError('not_found', '文件位置不存在')
        folders.push(folder)
        folderId = folder.parent_id === null ? null : Number(folder.parent_id)
      }
      if (folderId !== null) throw new CoreError('not_found', '文件位置超过允许的层级')
      return {
        file: fileResponse(file),
        folderPath: folders.reverse().map((folder) => ({
          id: Number(folder.id),
          projectId: nullableNumber(folder.project_id),
          workspaceDirectoryId: nullableNumber(folder.workspace_directory_id),
          parentId: nullableNumber(folder.parent_id),
          name: folder.name,
          fileCount: 0,
          folderCount: 0,
          version: Number(folder.version ?? 1),
        })),
      }
    },

    async resolveRelativePaths(ownerId, fileId, paths) {
      const source = await loadFile(pool, ownerId, fileId)
      if (!source) return null
      const folders = await sourceFolderPath(pool, ownerId, source)
      if (folders === null) return null
      const resolved = []
      for (const pathValue of paths)
        resolved.push(await resolveRelativePath(pool, ownerId, source, folders, pathValue))
      return resolved
    },

    async getSummary(ownerId, recentLimit) {
      const result = await pool.query<FileRow>(
        `SELECT ${fileProjection}
         FROM files file
         LEFT JOIN projects project ON project.id=file.project_id AND project.user_id=file.user_id
         LEFT JOIN folders folder ON folder.id=file.folder_id AND folder.user_id=file.user_id
         WHERE file.user_id=$1 AND file.deleted_at IS NULL
         ORDER BY file.id DESC LIMIT $2`,
        [ownerId, recentLimit],
      )
      return { recentFiles: result.rows.map(fileResponse) }
    },

    async getLibraryCounts(ownerId) {
      const result = await pool.query<QueryResultRow & Record<string, string>>(
        `SELECT
           (SELECT count(*) FROM files f WHERE f.user_id=$1 AND f.space='personal'
             AND COALESCE(f.project_id,f.workspace_directory_id,f.mind_map_id,0)=0
             AND COALESCE(f.folder_id,0)=0 AND f.deleted_at IS NULL) AS personal_file_count,
           (SELECT count(*) FROM folders f WHERE f.user_id=$1 AND f.project_id IS NULL
             AND f.workspace_directory_id IS NULL AND COALESCE(f.project_id,f.workspace_directory_id,0)=0
             AND COALESCE(f.parent_id,0)=0 AND f.deleted_at IS NULL) AS personal_folder_count,
           (SELECT count(*) FROM files f JOIN projects p ON p.id=f.project_id AND p.user_id=f.user_id
             WHERE f.user_id=$1 AND p.deleted_at IS NULL AND f.deleted_at IS NULL) AS project_file_count,
           (SELECT count(*) FROM folders f JOIN projects p ON p.id=f.project_id AND p.user_id=f.user_id
             WHERE f.user_id=$1 AND p.deleted_at IS NULL AND f.deleted_at IS NULL) AS project_folder_count,
           (SELECT count(*) FROM files f LEFT JOIN folders parent ON parent.id=f.folder_id AND parent.user_id=f.user_id
             WHERE f.user_id=$1 AND f.deleted_at IS NOT NULL
               AND (f.folder_id IS NULL OR parent.deleted_at IS NULL)) AS trash_file_count,
           (SELECT count(*) FROM folders f LEFT JOIN folders parent ON parent.id=f.parent_id AND parent.user_id=f.user_id
             WHERE f.user_id=$1 AND f.deleted_at IS NOT NULL
               AND (f.parent_id IS NULL OR parent.deleted_at IS NULL)) AS trash_folder_count`,
        [ownerId],
      )
      const row = result.rows[0]
      if (!row) throw new Error('文件库计数查询没有返回记录')
      return {
        personalFileCount: Number(row.personal_file_count),
        personalFolderCount: Number(row.personal_folder_count),
        projectFileCount: Number(row.project_file_count),
        projectFolderCount: Number(row.project_folder_count),
        trashFileCount: Number(row.trash_file_count),
        trashFolderCount: Number(row.trash_folder_count),
      }
    },

    async getStorage(ownerId) {
      const result = await pool.query<QueryResultRow & {
        storage_limit_bytes: number | string | null
        ledger_used_bytes: number | string | null
        file_used_bytes: number | string
      }>(
        `SELECT users.storage_limit_bytes,
                ledger.used_bytes AS ledger_used_bytes,
                COALESCE(SUM(files.size_bytes), 0) AS file_used_bytes
         FROM users
         LEFT JOIN storage_quota_ledgers ledger
           ON ledger.user_id=users.id AND ledger.category='file_library'
         LEFT JOIN files ON files.user_id=users.id
         WHERE users.id=$1
         GROUP BY users.id, users.storage_limit_bytes, ledger.used_bytes`,
        [ownerId],
      )
      const row = result.rows[0]
      if (!row) throw new CoreError('not_found', '用户不存在')
      const userLimit = row.storage_limit_bytes === null
        ? defaultStorageLimitBytes
        : Number(row.storage_limit_bytes) === -1 ? null : Number(row.storage_limit_bytes)
      return {
        used_bytes: Number(row.ledger_used_bytes ?? row.file_used_bytes),
        limit_bytes: userLimit,
      }
    },
  }
}
