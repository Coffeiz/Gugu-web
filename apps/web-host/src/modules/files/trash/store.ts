import { CoreError } from '@gugu/core'
import { randomUUID, createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { lockQuota, reconcileLocalUsage, releaseTrashQuota } from '../storage/quota.js'
import { stageLocalFileRemoval } from '../storage/removal.js'
import { normalizeFileOwnerId } from '../store.js'
import type { TrashOperations } from './service.js'

interface DeletedFileRow extends QueryResultRow {
  id: number | string
  storage_key: string
  size_bytes: number | string
}

export interface TrashMutationEvent {
  ownerId: string
  entityId: number
  entityType: 'file' | 'folder'
  origin: string | null
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
      let staged: Awaited<ReturnType<typeof stageLocalFileRemoval>> = null
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
        try {
          staged = await stageLocalFileRemoval(options.storageRoot, ownerId, file.storage_key, randomUUID())
          // 缺失文件与 Python 一样仍清理墓碑并释放账本；实际对象先暂存，等数据库提交后再销毁。
          deletedFromStorage = true
        } catch { /* 保留 Python 的坏对象清理语义，不因不可访问对象阻塞回收站。 */ }
        if (deletedFromStorage && quota !== null)
          await releaseTrashQuota(client, ownerId, fileId, Number(file.size_bytes), quota)
        await client.query('DELETE FROM files WHERE id=$1 AND user_id=$2', [fileId, ownerId])
        await client.query('COMMIT')
        committed = true
        fileDeleted = true
      } catch (error) {
        if (!committed) {
          let rolledBack = false
          try { await client.query('ROLLBACK'); rolledBack = true } catch { /* 回滚结果未知时不能猜测文件是否应恢复。 */ }
          if (rolledBack && staged) await staged.restore()
        }
        throw error
      } finally {
        client.release()
      }
      await staged?.discard().catch(() => undefined)
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
      const stagedFiles: Array<NonNullable<Awaited<ReturnType<typeof stageLocalFileRemoval>>>> = []
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
          try {
            const staged = await stageLocalFileRemoval(options.storageRoot, ownerId, file.storage_key, randomUUID())
            deletedFromStorage = true
            if (staged) stagedFiles.push(staged)
          } catch { /* 保留 Python 的坏对象清理语义；成功暂存的对象在提交失败时可恢复。 */ }
          if (deletedFromStorage && Number(file.size_bytes) > 0) {
            usedBytes = await releaseTrashQuota(client, ownerId, Number(file.id), Number(file.size_bytes), usedBytes)
          }
        }
        await client.query('DELETE FROM files WHERE user_id=$1 AND folder_id=ANY($2::integer[]) AND deleted_at IS NOT NULL', [ownerId, folderIds])
        await client.query('DELETE FROM folders WHERE user_id=$1 AND id=ANY($2::integer[]) AND deleted_at IS NOT NULL', [ownerId, folderIds])
        await client.query('COMMIT')
        committed = true
      } catch (error) {
        if (!committed) {
          let rolledBack = false
          try { await client.query('ROLLBACK'); rolledBack = true } catch { /* 回滚结果未知时不能猜测文件是否应恢复。 */ }
          if (rolledBack) {
            for (const staged of stagedFiles.reverse()) await staged.restore()
          }
        }
        throw error
      } finally {
        client.release()
      }
      for (const staged of stagedFiles) await staged.discard().catch(() => undefined)
      for (const entityId of deletedFileIds)
        await options.publishChanged({ ownerId, entityId, entityType: 'file', origin }).catch(() => undefined)
      await options.publishChanged({ ownerId, entityId: folderId, entityType: 'folder', origin }).catch(() => undefined)
    },
  }
}

type PageValue = string | number

interface CursorPayload {
  v: 1
  user: string
  scope: Record<string, unknown>
  value: PageValue
  id: number
}

interface FilePageRow extends QueryResultRow {
  id: number | string
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
  created_at: Date | string
  deleted_at: Date | string
  img_width: number | string | null
  img_height: number | string | null
  version: number | string
  page_sort: string
}

interface FolderPageRow extends QueryResultRow {
  id: number | string
  project_id: number | string | null
  workspace_directory_id: number | string | null
  parent_id: number | string | null
  name: string
  version: number | string
  deleted_at: Date | string
  file_count: number | string
  folder_count: number | string
  page_sort: string
}

const cursorAad = Buffer.from('gugu-file-page-cursor-v1')

function cursorKey(secret: string): Buffer {
  return createHash('sha256').update(`file-page-cursor:${secret}`).digest()
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function encodeCursor(secret: string, payload: CursorPayload): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', cursorKey(secret), nonce)
  cipher.setAAD(cursorAad)
  const encrypted = Buffer.concat([cipher.update(Buffer.from(canonicalJson(payload))), cipher.final()])
  return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString('base64url')
}

function decodeCursor(
  secret: string,
  token: string | null,
  user: string,
  scope: Record<string, unknown>,
): [PageValue, number] | null {
  if (token === null) return null
  try {
    if (token.length > 4096) throw new Error()
    const bytes = Buffer.from(token, 'base64url')
    if (bytes.length < 29) throw new Error()
    const decipher = createDecipheriv('aes-256-gcm', cursorKey(secret), bytes.subarray(0, 12))
    decipher.setAAD(cursorAad)
    decipher.setAuthTag(bytes.subarray(-16))
    const payload = JSON.parse(Buffer.concat([
      decipher.update(bytes.subarray(12, -16)), decipher.final(),
    ]).toString()) as CursorPayload
    if (payload.v !== 1 || payload.user !== user || canonicalJson(payload.scope) !== canonicalJson(scope)
      || !['string', 'number'].includes(typeof payload.value) || !Number.isSafeInteger(payload.id)
      || payload.id < 1) throw new Error()
    return [payload.value, payload.id]
  } catch {
    throw new CoreError('invalid_request', '分页游标无效或已失效')
  }
}

function nextCursor(
  secret: string,
  user: string,
  scope: Record<string, unknown>,
  value: string,
  id: number,
): string {
  return encodeCursor(secret, { v: 1, user, scope, value, id })
}

function page<T extends { id: number; pageSort: string }>(
  items: T[], limit: number, secret: string, user: string, scope: Record<string, unknown>,
) {
  const hasMore = items.length > limit
  const visible = items.slice(0, limit)
  const last = visible.at(-1)
  return {
    items: visible.map(({ pageSort: _pageSort, ...item }) => item),
    has_more: hasMore,
    next_cursor: hasMore && last ? nextCursor(secret, user, scope, last.pageSort, last.id) : null,
  }
}

function isoUtc(value: Date | string): string {
  if (value instanceof Date) return value.toISOString()
  const normalized = value.replace(' ', 'T')
  return /(?:Z|[+-]\d\d:\d\d)$/.test(normalized) ? normalized : `${normalized.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '')}Z`
}

function localTimestamp(value: Date | string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 19)
  return String(value).replace(' ', 'T').slice(0, 19)
}

function colorValue(raw: string | null): string | null {
  if (!raw) return null
  return raw.match(/#[0-9a-fA-F]{3,6}/)?.[0] ?? raw
}

function fileResponse(row: FilePageRow) {
  return {
    id: Number(row.id), display_name: row.display_name, ext: row.ext, space: row.space,
    workspace_directory_id: row.workspace_directory_id === null ? null : Number(row.workspace_directory_id),
    project_id: row.project_id === null ? null : Number(row.project_id), project_name: row.project_name,
    project_color: colorValue(row.project_color), stage_name: row.stage_name,
    folder_id: row.folder_id === null ? null : Number(row.folder_id), folder_name: row.folder_name,
    mind_map_id: row.mind_map_id === null ? null : Number(row.mind_map_id), size: row.size,
    size_bytes: Number(row.size_bytes), mime_type: row.mime_type, created_at: isoUtc(row.created_at),
    deleted_at: localTimestamp(row.deleted_at), img_width: row.img_width === null ? null : Number(row.img_width),
    img_height: row.img_height === null ? null : Number(row.img_height), version: Number(row.version || 1),
  }
}

function folderResponse(row: FolderPageRow) {
  return {
    id: Number(row.id), project_id: row.project_id === null ? null : Number(row.project_id),
    workspace_directory_id: row.workspace_directory_id === null ? null : Number(row.workspace_directory_id),
    parent_id: row.parent_id === null ? null : Number(row.parent_id), name: row.name,
    file_count: Number(row.file_count), folder_count: Number(row.folder_count),
    version: Number(row.version || 1), deleted_at: localTimestamp(row.deleted_at),
  }
}

function pageRows<T extends QueryResultRow & { id: number | string; page_sort: string }>(
  rows: T[], limit: number, mapper: (row: T) => Record<string, unknown>,
) {
  return rows.slice(0, limit + 1).map((row) => ({ ...mapper(row), id: Number(row.id), pageSort: row.page_sort }))
}

const orderOperator = '<'

export function createPostgresTrashReadOperations(pool: Pool, secret: string, projection: {
  file(row: FilePageRow): Record<string, unknown>
  folder(row: FolderPageRow): Record<string, unknown>
} = { file: fileResponse, folder: folderResponse }): Pick<
  TrashOperations, 'listFiles' | 'listFolders' | 'listFolderContents'
> {
  return {
    async listFiles(rawOwner, query) {
      const ownerId = normalizeFileOwnerId(rawOwner)
      const scope = { resource: 'trash_files', sort: 'deletedAt_desc_id_desc' }
      const boundary = decodeCursor(secret, query.cursor, ownerId, scope)
      const values: unknown[] = [ownerId]
      let boundarySql = ''
      if (boundary) {
        values.push(boundary[0], boundary[1])
        boundarySql = `AND (file.deleted_at,file.id) ${orderOperator} ($2::timestamptz,$3::integer)`
      }
      values.push(query.limit + 1)
      const result = await pool.query<FilePageRow>(
        `SELECT file.id,file.display_name,file.ext,file.space,file.workspace_directory_id,file.project_id,
          project.name AS project_name,project.color AS project_color,file.stage_name,file.folder_id,folder.name AS folder_name,
          file.mind_map_id,file.size,file.size_bytes,file.mime_type,file.created_at,file.deleted_at,
          file.img_width,file.img_height,file.version,
          to_char(file.deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS page_sort
         FROM files file LEFT JOIN projects project ON project.id=file.project_id AND project.user_id=$1
         LEFT JOIN folders folder ON folder.id=file.folder_id AND folder.user_id=$1
         WHERE file.user_id=$1 AND file.deleted_at IS NOT NULL
           AND (file.folder_id IS NULL OR folder.deleted_at IS NULL) ${boundarySql}
         ORDER BY file.deleted_at DESC,file.id DESC LIMIT $${values.length}`,
        values,
      )
      const rows = pageRows(result.rows, query.limit, projection.file)
      return page(rows, query.limit, secret, ownerId, scope)
    },

    async listFolders(rawOwner, query) {
      const ownerId = normalizeFileOwnerId(rawOwner)
      const scope = { resource: 'trash_folders', sort: 'deletedAt_desc_id_desc' }
      const boundary = decodeCursor(secret, query.cursor, ownerId, scope)
      const values: unknown[] = [ownerId]
      let boundarySql = ''
      if (boundary) {
        values.push(boundary[0], boundary[1])
        boundarySql = 'AND (folder.deleted_at,folder.id)<($2::timestamptz,$3::integer)'
      }
      values.push(query.limit + 1)
      const result = await pool.query<FolderPageRow>(
        `SELECT folder.id,folder.project_id,folder.workspace_directory_id,folder.parent_id,
          folder.name,folder.version,folder.deleted_at,
          (SELECT count(*)::int FROM files file WHERE file.user_id=$1 AND file.folder_id=folder.id AND file.deleted_at IS NOT NULL) AS file_count,
          (SELECT count(*)::int FROM folders child WHERE child.user_id=$1 AND child.parent_id=folder.id AND child.deleted_at IS NOT NULL) AS folder_count,
          to_char(folder.deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS page_sort
         FROM folders folder LEFT JOIN folders parent ON parent.id=folder.parent_id AND parent.user_id=$1
         WHERE folder.user_id=$1 AND folder.deleted_at IS NOT NULL
           AND (folder.parent_id IS NULL OR parent.deleted_at IS NULL) ${boundarySql}
         ORDER BY folder.deleted_at DESC,folder.id DESC LIMIT $${values.length}`,
        values,
      )
      const rows = pageRows(result.rows, query.limit, projection.folder)
      return page(rows, query.limit, secret, ownerId, scope)
    },

    async listFolderContents(rawOwner, folderId, query) {
      const ownerId = normalizeFileOwnerId(rawOwner)
      if (!Number.isSafeInteger(folderId) || folderId < 1) throw new CoreError('invalid_request', '文件夹 ID 无效')
      const root = await pool.query<{ id: number | string }>(
        `SELECT folder.id FROM folders folder LEFT JOIN folders parent ON parent.id=folder.parent_id AND parent.user_id=$2
         WHERE folder.id=$1 AND folder.user_id=$2 AND folder.deleted_at IS NOT NULL
           AND (folder.parent_id IS NULL OR parent.deleted_at IS NULL)`, [folderId, ownerId],
      )
      if (!root.rowCount) return null

      const folderScope = { resource: 'trash_folder_children', folder_id: folderId }
      const folderBoundary = decodeCursor(secret, query.folderCursor, ownerId, folderScope)
      const folderValues: unknown[] = [ownerId, folderId]
      let folderBoundarySql = ''
      if (folderBoundary) {
        folderValues.push(folderBoundary[0], folderBoundary[1])
        folderBoundarySql = `AND (folder.deleted_at,folder.id)<($3::timestamptz,$4::integer)`
      }
      folderValues.push(query.limit + 1)
      const folders = await pool.query<FolderPageRow>(
        `SELECT folder.id,folder.project_id,folder.workspace_directory_id,folder.parent_id,
          folder.name,folder.version,folder.deleted_at,
          (SELECT count(*)::int FROM files file WHERE file.user_id=$1 AND file.folder_id=folder.id AND file.deleted_at IS NOT NULL) AS file_count,
          (SELECT count(*)::int FROM folders child WHERE child.user_id=$1 AND child.parent_id=folder.id AND child.deleted_at IS NOT NULL) AS folder_count,
          to_char(folder.deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS page_sort
         FROM folders folder WHERE folder.user_id=$1 AND folder.parent_id=$2 AND folder.deleted_at IS NOT NULL
           ${folderBoundarySql} ORDER BY folder.deleted_at DESC,folder.id DESC LIMIT $${folderValues.length}`,
        folderValues,
      )

      const fileScope = { resource: 'trash_folder_files', folder_id: folderId }
      const fileBoundary = decodeCursor(secret, query.fileCursor, ownerId, fileScope)
      const fileValues: unknown[] = [ownerId, folderId]
      let fileBoundarySql = ''
      if (fileBoundary) {
        fileValues.push(fileBoundary[0], fileBoundary[1])
        fileBoundarySql = `AND (file.deleted_at,file.id)<($3::timestamptz,$4::integer)`
      }
      fileValues.push(query.limit + 1)
      const files = await pool.query<FilePageRow>(
        `SELECT file.id,file.display_name,file.ext,file.space,file.workspace_directory_id,file.project_id,
          project.name AS project_name,project.color AS project_color,file.stage_name,file.folder_id,folder.name AS folder_name,
          file.mind_map_id,file.size,file.size_bytes,file.mime_type,file.created_at,file.deleted_at,
          file.img_width,file.img_height,file.version,
          to_char(file.deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS page_sort
         FROM files file LEFT JOIN projects project ON project.id=file.project_id AND project.user_id=$1
         LEFT JOIN folders folder ON folder.id=file.folder_id AND folder.user_id=$1
         WHERE file.user_id=$1 AND file.folder_id=$2 AND file.deleted_at IS NOT NULL ${fileBoundarySql}
         ORDER BY file.deleted_at DESC,file.id DESC LIMIT $${fileValues.length}`,
        fileValues,
      )

      return {
        folders: page(pageRows(folders.rows, query.limit, folderResponse), query.limit, secret, ownerId, folderScope),
        files: page(pageRows(files.rows, query.limit, fileResponse), query.limit, secret, ownerId, fileScope),
      }
    },
  }
}

/** Agent与Web共用相同owner/顶层过滤SQL；保留原始微秒，避免Web展示投影损失排序精度。 */
export function createPostgresAgentTrashReader(pool: Pool, secret: string) {
  const deletedAt = (stamp: string) => `${stamp.endsWith('.000000') ? stamp.slice(0, -7) : stamp}+00:00`
  return createPostgresTrashReadOperations(pool, secret, {
    file: row => ({ id: Number(row.id), file_id: Number(row.id), kind: 'file',
      name: `${row.display_name}.${row.ext}`, space: row.space, deleted_at: deletedAt(row.page_sort) }),
    folder: row => ({ id: Number(row.id), folder_id: Number(row.id), kind: 'folder', name: row.name,
      space: row.project_id !== null ? 'project' : row.workspace_directory_id !== null ? 'workspace' : 'personal',
      deleted_at: deletedAt(row.page_sort) }),
  })
}
