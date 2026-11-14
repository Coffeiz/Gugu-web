import { CoreError } from '@gugu/core'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { isPathWithin } from '../../adapters/path-safety.js'
import type { WriteRequestMetadata } from '../../app.js'
import { normalizeFileOwnerId } from './file-owner.js'
import { formatFileSize } from './file-size.js'
import type { FileContentOperations } from './file-content.js'
import { lockFileSyncPath, recordCanonicalFileChange } from './persistence/file-sync-canonical-change.js'

const FILE_LIBRARY = 'file_library'
const TEXT_EXTS = new Set([
  'md', 'markdown', 'txt', 'text', 'json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'html', 'htm', 'css',
  'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'rb', 'php', 'sh', 'bash',
  'sql', 'ini', 'toml', 'conf', 'log', 'vue', 'svg', 'env', 'm3u', 'm3u8',
])

interface FileRow extends QueryResultRow {
  id: number | string; user_id: string; display_name: string; ext: string; space: string
  project_id: number | string | null; folder_id: number | string | null
  workspace_directory_id: number | string | null; stage_name: string; mind_map_id: number | string | null
  storage_key: string; version: number | string; size: string; size_bytes: number | string
  mime_type: string | null; img_width: number | string | null; img_height: number | string | null
  created_at: Date | string; project_name?: string | null; project_color?: string | null; folder_name?: string | null
}

async function storagePath(rootPath: string, key: string): Promise<string> {
  const parts = key.split('/')
  if (parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')))
    throw new CoreError('not_found', '文件不存在')
  const root = await realpath(rootPath)
  let cursor = root
  for (const part of parts) {
    cursor = path.resolve(cursor, part)
    if (!isPathWithin(root, cursor)) throw new CoreError('not_found', '文件不存在')
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new CoreError('not_found', '文件不存在')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return cursor
}

function snapshot(row: FileRow) {
  return {
    id: Number(row.id), display_name: row.display_name, ext: row.ext, space: row.space,
    project_id: row.project_id === null ? null : Number(row.project_id),
    folder_id: row.folder_id === null ? null : Number(row.folder_id),
    workspace_directory_id: row.workspace_directory_id === null ? null : Number(row.workspace_directory_id),
    stage_name: row.stage_name, mind_map_id: row.mind_map_id === null ? null : Number(row.mind_map_id),
    storage_key: row.storage_key, version: Number(row.version), size: row.size, size_bytes: Number(row.size_bytes),
    mime_type: row.mime_type, img_width: row.img_width === null ? null : Number(row.img_width),
    img_height: row.img_height === null ? null : Number(row.img_height), deleted_at: null,
  }
}

async function recordUndo(
  client: PoolClient, ownerId: string, contextId: string | null, before: FileRow, after: FileRow,
  beforeKey: string, afterKey: string,
): Promise<void> {
  const context = contextId?.trim().slice(0, 128)
  if (!context) return
  const ref = `file:${after.id}`
  const id = `op-${randomUUID().replaceAll('-', '')}`
  await client.query(
    `UPDATE undo_operations SET status='expired',failure_code='redo_cleared_by_new_operation'
     WHERE user_id=$1 AND undo_context_id=$2 AND actor_type='web' AND status='undone'`, [ownerId, context],
  )
  await client.query(
    `INSERT INTO undo_operations (id,user_id,undo_context_id,group_id,resource,action,target_refs,
       before_state,after_state,base_versions,artifact_refs,actor_type,status,created_at,expires_at,undone_at,failure_code)
     VALUES ($1,$2,$3,$4,'files','update',$5::json,$6::json,$7::json,$8::json,$9::json,
       'web','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '30 days',NULL,NULL)`,
    [id, ownerId, context, `group-${randomUUID().replaceAll('-', '')}`,
      JSON.stringify([{ kind: 'file', id: Number(after.id) }]),
      JSON.stringify({ items: { [ref]: snapshot(before) } }), JSON.stringify({ items: { [ref]: snapshot(after) } }),
      JSON.stringify({ [ref]: { version: Number(before.version) } }),
      JSON.stringify({ [ref]: { before_key: beforeKey, after_key: afterKey } })],
  )
}

function response(row: FileRow) {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : `${row.created_at.replace(/Z?$/, 'Z')}`
  return {
    id: Number(row.id), displayName: row.display_name, ext: row.ext, space: row.space,
    workspaceDirectoryId: row.workspace_directory_id === null ? null : Number(row.workspace_directory_id),
    projectId: row.project_id === null ? null : Number(row.project_id), projectName: row.project_name ?? null,
    projectColor: row.project_color?.match(/#[0-9a-fA-F]{3,6}/)?.[0] ?? row.project_color ?? null,
    stageName: row.stage_name, folderId: row.folder_id === null ? null : Number(row.folder_id),
    folderName: row.folder_name ?? null, mindMapId: row.mind_map_id === null ? null : Number(row.mind_map_id),
    size: row.size, sizeBytes: Number(row.size_bytes), mimeType: row.mime_type, createdAt, deletedAt: null,
    imgWidth: row.img_width === null ? null : Number(row.img_width),
    imgHeight: row.img_height === null ? null : Number(row.img_height), version: Number(row.version),
  }
}

export function createPostgresFileContentOperations(
  pool: Pool,
  options: {
    storageRoot: string
    fileSyncEnabled?: boolean
    publishChanged(event: { ownerId: string; entityId: number; payload: Record<string, unknown>; origin: string | null }): Promise<void>
  },
): FileContentOperations {
  return {
    async update(rawOwnerId, fileId, content, version, metadata: WriteRequestMetadata) {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      const data = Buffer.from(content, 'utf8')
      if (data.byteLength > 1024 * 1024) throw Object.assign(new Error('内容过大（上限 1MB）'), { statusCode: 400 })
      const client = await pool.connect()
      let committed = false
      let destination: string | null = null
      let rollbackPath: string | null = null
      let stagedPath: string | null = null
      const artifactPaths: string[] = []
      try {
        await client.query('BEGIN')
        const found = await client.query<FileRow>(
          'SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE', [fileId, ownerId],
        )
        const before = found.rows[0]
        if (!before) throw new CoreError('not_found', '文件不存在')
        await lockFileSyncPath(client, ownerId, before.storage_key)
        const mime = (before.mime_type ?? '').toLowerCase()
        if (!TEXT_EXTS.has(before.ext.toLowerCase()) && !mime.startsWith('text/')
          && !['application/json', 'application/xml', 'application/javascript', 'application/typescript', 'application/sql', 'application/x-sh'].includes(mime)
          && !mime.endsWith('+json') && !mime.endsWith('+xml'))
          throw Object.assign(new Error('仅文本类文件可改内容'), { statusCode: 400 })
        if (Number(before.version) !== version) throw new CoreError('conflict', '文件已被其他端修改，请刷新后重试')
        destination = await storagePath(options.storageRoot, before.storage_key)
        const beforeData = await readFile(destination).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') throw new CoreError('not_found', '文件不存在于存储')
          throw error
        })
        const directory = await mkdtemp(path.join(path.dirname(destination), '.content-stage-'))
        stagedPath = path.join(directory, 'content')
        await writeFile(stagedPath, data, { flag: 'wx', mode: 0o600 })
        const next = await client.query<FileRow>(
          `UPDATE files SET version=version+1,size=$4,size_bytes=$5,updated_at=CURRENT_TIMESTAMP
           WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL AND version=$3 RETURNING *`,
          [fileId, ownerId, version, formatFileSize(data.byteLength), data.byteLength],
        )
        const after = next.rows[0]
        if (!after) throw new CoreError('conflict', '文件已被其他端修改，请刷新后重试')
        const undoContext = metadata.undoContextId?.trim().slice(0, 128) || null
        let beforeKey = ''
        let afterKey = ''
        if (undoContext) {
          const prefix = `${ownerId}/.undo/op-${randomUUID().replaceAll('-', '')}/file-${fileId}`
          beforeKey = `${prefix}/before`
          afterKey = `${prefix}/after`
          const beforePath = await storagePath(options.storageRoot, beforeKey)
          const afterPath = await storagePath(options.storageRoot, afterKey)
          await mkdir(path.dirname(beforePath), { recursive: true, mode: 0o700 })
          await copyFile(destination, beforePath)
          artifactPaths.push(beforePath, afterPath)
          await copyFile(stagedPath, afterPath)
          await recordUndo(client, ownerId, undoContext, before, after, beforeKey, afterKey)
        }
        rollbackPath = `${stagedPath}.old`
        await rename(destination, rollbackPath)
        await rename(stagedPath, destination)
        await recordCanonicalFileChange(client, {
          ownerId,
          storageRoot: options.storageRoot,
          storageKey: before.storage_key,
          observedFingerprint: createHash('sha256').update(data).digest('hex'),
          enabled: options.fileSyncEnabled ?? true,
        })
        await client.query('COMMIT')
        committed = true
        await rm(rollbackPath, { force: true })
        const full = await client.query<FileRow>(
          `SELECT file.*,project.name AS project_name,project.color AS project_color,folder.name AS folder_name
           FROM files file LEFT JOIN projects project ON project.id=file.project_id AND project.user_id=file.user_id
           LEFT JOIN folders folder ON folder.id=file.folder_id AND folder.user_id=file.user_id
           WHERE file.id=$1 AND file.user_id=$2`, [fileId, ownerId],
        )
        const result = full.rows[0] ? response(full.rows[0]) : response(after)
        await options.publishChanged({ ownerId, entityId: fileId, payload: result, origin: metadata.clientId }).catch(() => undefined)
        return result
      } catch (error) {
        if (!committed) {
          await client.query('ROLLBACK').catch(() => undefined)
          if (destination && rollbackPath) await rename(rollbackPath, destination).catch(() => undefined)
          for (const artifact of artifactPaths) await rm(artifact, { force: true }).catch(() => undefined)
        }
        throw error
      } finally {
        if (stagedPath) await rm(path.dirname(stagedPath), { recursive: true, force: true }).catch(() => undefined)
        client.release()
      }
    },
  }
}
