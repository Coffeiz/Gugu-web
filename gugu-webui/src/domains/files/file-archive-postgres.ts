import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, link, lstat, mkdir, mkdtemp, realpath, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { createGunzip } from 'node:zlib'
import JSZip from 'jszip'
import * as tar from 'tar'
import { CoreError } from '@gugu/core'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import type { WriteRequestMetadata } from '../../app.js'
import { isPathWithin } from '../../adapters/path-safety.js'
import { formatFileSize } from './file-size.js'
import type { FileArchiveInput, FileArchiveOperations, FileUnarchiveInput } from './file-archive.js'
import {
  archiveMimeType, buildFolderArchiveEntries, MAX_ARCHIVE_ENTRIES, MAX_COMPRESS_SOURCE_BYTES, MAX_EXTRACT_BYTES,
  nextArchiveName, safeArchivePath, splitArchiveFilename, supportedArchiveFormat,
} from './file-archive-rules.js'
import type { FolderArchiveFileRecord, FolderArchiveTreeRecord } from './file-archive-rules.js'
import { recordCanonicalFileChange, lockFileSyncPath } from './persistence/file-sync-canonical-change.js'

type Row = QueryResultRow & Record<string, any>
type Scope = { space: 'personal' | 'project' | 'workspace'; projectId: number | null; workspaceId: number | null }
type Entry = { archivePath: string; kind: 'file' | 'folder'; row?: Row; sourcePath?: string }
export type ExtractedMember = { archivePath: string; kind: 'file' | 'folder'; size: number; stagedPath?: string }

const safeNameChars = /[\\/:*?"<>|\0]/g
const CHUNK = 1024 * 1024

function ownerId(value: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new CoreError('invalid_request', '用户标识无效')
  return value.toLowerCase()
}

function scopeOf(row: Row): Scope {
  const space = row.space || (row.project_id !== null ? 'project' : 'personal')
  if (space !== 'personal' && space !== 'project' && space !== 'workspace')
    throw new CoreError('invalid_request', '该文件空间暂不支持压缩与解压')
  return { space, projectId: row.project_id === null ? null : Number(row.project_id),
    workspaceId: row.workspace_directory_id === null ? null : Number(row.workspace_directory_id) }
}

function sameScope(left: Scope, right: Scope): boolean {
  return left.space === right.space && left.projectId === right.projectId && left.workspaceId === right.workspaceId
}

function safeSegment(value: string): string {
  const result = value.replace(safeNameChars, '_')
  if (!result || result === '.' || result === '..') throw new CoreError('invalid_request', '文件名称无效')
  return result
}

async function localPath(rootPath: string, userId: string, key: string): Promise<string> {
  const segments = key.split('/')
  if (segments.length < 2 || segments[0] !== userId
    || segments.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')))
    throw new CoreError('not_found', '文件不存在')
  const root = await realpath(rootPath)
  let current = root
  for (const part of segments) {
    current = path.resolve(current, part)
    if (!isPathWithin(root, current)) throw new CoreError('not_found', '文件不存在')
    try { if ((await lstat(current)).isSymbolicLink()) throw new CoreError('not_found', '文件不存在') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return current
}

async function folderPath(client: PoolClient, userId: string, folderId: number | null,
  scope: Scope): Promise<{ ids: number[]; names: string[] }> {
  if (folderId === null) return { ids: [], names: [] }
  const result = await client.query<Row>(
    `WITH RECURSIVE chain AS (
       SELECT id,parent_id,name,project_id,workspace_directory_id,0 depth FROM folders
       WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
       UNION ALL
       SELECT parent.id,parent.parent_id,parent.name,parent.project_id,parent.workspace_directory_id,chain.depth+1
       FROM folders parent JOIN chain ON chain.parent_id=parent.id
       WHERE parent.user_id=$2 AND parent.deleted_at IS NULL AND chain.depth<64
     ) SELECT * FROM chain ORDER BY depth DESC`, [folderId, userId])
  if (!result.rows.length || result.rows[0]!.parent_id !== null
    || result.rows.some((row) => Number(row.project_id ?? 0) !== Number(scope.projectId ?? 0)
      || Number(row.workspace_directory_id ?? 0) !== Number(scope.workspaceId ?? 0)))
    throw new CoreError('not_found', '目标文件夹不存在')
  return { ids: result.rows.map((row) => Number(row.id)), names: result.rows.map((row) => String(row.name)) }
}

async function storageKey(client: PoolClient, userId: string, scope: Scope, folderId: number | null,
  filename: string): Promise<{ key: string; folderName: string | null; project: Row | null }> {
  const folder = await folderPath(client, userId, folderId, scope)
  let prefix: string[]
  let project: Row | null = null
  if (scope.space === 'project') {
    const query = await client.query<Row>(
      `SELECT id,name,color,COALESCE(to_char(start_date,'YYYY'),to_char(created_at,'YYYY')) year_value,
       COALESCE(to_char(start_date,'MM'),to_char(created_at,'MM')) month_value
       FROM projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [scope.projectId, userId])
    project = query.rows[0] ?? null
    if (!project) throw new CoreError('not_found', '项目不存在')
    prefix = [userId, '项目文件', String(project.year_value), String(project.month_value),
      `${safeSegment(String(project.name))} #${scope.projectId}`]
  } else if (scope.space === 'workspace') {
    const query = await client.query<Row>(
      'SELECT directory_name FROM workspace_directories WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
      [scope.workspaceId, userId])
    if (!query.rows[0]) throw new CoreError('not_found', 'Workspace 不存在')
    prefix = [userId, 'workspace', safeSegment(String(query.rows[0].directory_name))]
  } else prefix = [userId, '个人文件']
  const key = [...prefix, ...folder.names.map(safeSegment), filename].join('/')
  return { key, folderName: folder.names.at(-1) ?? null, project }
}

function fileResponse(row: Row, project: Row | null, folderName: string | null) {
  const created = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
  return {
    id: Number(row.id), displayName: String(row.display_name), ext: String(row.ext), space: String(row.space),
    workspaceDirectoryId: row.workspace_directory_id == null ? null : Number(row.workspace_directory_id),
    projectId: row.project_id == null ? null : Number(row.project_id), projectName: project?.name ?? null,
    projectColor: project?.color?.match(/#[0-9a-fA-F]{3,6}/)?.[0] ?? project?.color ?? null,
    stageName: row.stage_name ?? '', folderId: row.folder_id == null ? null : Number(row.folder_id), folderName,
    mindMapId: null, size: row.size, sizeBytes: Number(row.size_bytes), mimeType: row.mime_type,
    createdAt: created.endsWith('Z') ? created : `${created}Z`, deletedAt: null,
    imgWidth: null, imgHeight: null, version: Number(row.version ?? 1),
  }
}

async function quotaRemaining(client: PoolClient, userId: string, defaultLimit: number | null): Promise<number> {
  const [user, ledger] = await Promise.all([
    client.query<{ storage_limit_bytes: string | number | null }>('SELECT storage_limit_bytes FROM users WHERE id=$1', [userId]),
    client.query<{ used_bytes: string | number; reserved_bytes: string | number; limit_bytes: string | number }>(
      `SELECT used_bytes,reserved_bytes,limit_bytes FROM storage_quota_ledgers
       WHERE user_id=$1 AND category='file_library' AND status='active' FOR UPDATE`, [userId]),
  ])
  if (!user.rowCount) throw new CoreError('not_found', '用户不存在')
  const configured = user.rows[0]!.storage_limit_bytes == null ? defaultLimit : Number(user.rows[0]!.storage_limit_bytes)
  if (configured === null || configured === -1) return Number.MAX_SAFE_INTEGER
  const row = ledger.rows[0]
  if (!row) throw new CoreError('busy', '存储配额账本尚未就绪，请稍后重试')
  const limit = Number(row.limit_bytes)
  if (limit !== configured) {
    await client.query(`UPDATE storage_quota_ledgers SET limit_bytes=$2,updated_at=CURRENT_TIMESTAMP
      WHERE user_id=$1 AND category='file_library'`, [userId, configured])
  }
  return Math.max(0, configured - Number(row.used_bytes) - Number(row.reserved_bytes))
}

async function recordQuota(client: PoolClient, userId: string, delta: number,
  operation: 'archive_compress' | 'archive_extract'): Promise<void> {
  const row = await client.query<{ used_bytes: string | number; reserved_bytes: string | number; limit_bytes: string | number }>(
    `SELECT used_bytes,reserved_bytes,limit_bytes FROM storage_quota_ledgers
     WHERE user_id=$1 AND category='file_library' AND status='active' FOR UPDATE`, [userId])
  const ledger = row.rows[0]
  if (!ledger) throw new CoreError('busy', '存储配额账本尚未就绪，请稍后重试')
  const limit = Number(ledger.limit_bytes)
  const used = Number(ledger.used_bytes) + delta
  if (used < 0 || (limit < Number.MAX_SAFE_INTEGER && used + Number(ledger.reserved_bytes) > limit))
    throw new CoreError('conflict', '存储空间不足')
  await client.query(`UPDATE storage_quota_ledgers SET used_bytes=$2,updated_at=CURRENT_TIMESTAMP
    WHERE user_id=$1 AND category='file_library'`, [userId, used])
  const operationId = randomUUID()
  await client.query(`INSERT INTO storage_quota_events
    (user_id,category,operation,delta_bytes,resource_type,resource_id,idempotency_key,metadata_json,created_at)
    VALUES($1,'file_library',$2,$3,'archive',$4,$5,NULL,CURRENT_TIMESTAMP)`,
  [userId, operation, delta, operationId, `${operation}:${operationId}`])
}

async function compressionEntries(client: PoolClient, userId: string, input: FileArchiveInput): Promise<{
  entries: Entry[]; scope: Scope; defaultFolderId: number | null; sourceBytes: number; defaultName: string
}> {
  const fileIds = [...new Set(input.fileIds)]
  const folderIds = [...new Set(input.folderIds)]
  if (!fileIds.length && !folderIds.length) throw new CoreError('invalid_request', '请先选择要压缩的文件或文件夹')
  const [fileRows, rootRows] = await Promise.all([
    fileIds.length ? client.query<Row>(
      'SELECT * FROM files WHERE id=ANY($1::integer[]) AND user_id=$2 AND deleted_at IS NULL', [fileIds, userId]) : { rows: [] as Row[] },
    folderIds.length ? client.query<Row>(
      'SELECT * FROM folders WHERE id=ANY($1::integer[]) AND user_id=$2 AND deleted_at IS NULL', [folderIds, userId]) : { rows: [] as Row[] },
  ])
  if (fileRows.rows.length !== fileIds.length || rootRows.rows.length !== folderIds.length)
    throw new CoreError('not_found', '所选文件或文件夹不存在')
  const filesById = new Map(fileRows.rows.map((row) => [Number(row.id), row]))
  const selectedFiles = fileIds.map((id) => filesById.get(id)!)
  const selectedFoldersById = new Map(rootRows.rows.map((row) => [Number(row.id), row]))
  const selectedFolders = folderIds.map((id) => selectedFoldersById.get(id)!)
  const rootsById = new Map(selectedFolders.map((row) => [Number(row.id), row]))
  const sourceScopes = [...selectedFiles.map(scopeOf), ...selectedFolders.map((row) => ({
    space: row.workspace_directory_id != null ? 'workspace' : row.project_id != null ? 'project' : 'personal',
    projectId: row.project_id == null ? null : Number(row.project_id),
    workspaceId: row.workspace_directory_id == null ? null : Number(row.workspace_directory_id),
  } as Scope))]
  const scope = sourceScopes[0]!
  if (sourceScopes.some((candidate) => !sameScope(scope, candidate)))
    throw new CoreError('invalid_request', '不能跨空间压缩')

  const rootIds: number[] = []
  for (const root of selectedFolders) {
    const ancestors = await folderPath(client, userId, Number(root.id), scope)
    if (!ancestors.ids.slice(0, -1).some((id) => rootsById.has(id))) rootIds.push(Number(root.id))
  }
  const treeRows = rootIds.length ? await client.query<Row & FolderArchiveTreeRecord>(
    `WITH RECURSIVE tree AS (
       SELECT id,parent_id,name,project_id,workspace_directory_id,id AS root_id,ARRAY[name]::text[] AS relative_path,0 depth
       FROM folders WHERE id=ANY($1::integer[]) AND user_id=$2 AND deleted_at IS NULL
       UNION ALL
       SELECT child.id,child.parent_id,child.name,child.project_id,child.workspace_directory_id,
         tree.root_id,tree.relative_path || child.name,tree.depth+1
       FROM folders child JOIN tree ON child.parent_id=tree.id
       WHERE child.user_id=$2 AND child.deleted_at IS NULL AND tree.depth<64
     ) SELECT * FROM tree ORDER BY relative_path,id`, [rootIds, userId]) : { rows: [] as Array<Row & FolderArchiveTreeRecord> }
  const treeById = new Map<number, Row>()
  for (const row of treeRows.rows) {
    if (Number(row.project_id ?? 0) !== Number(scope.projectId ?? 0)
      || Number(row.workspace_directory_id ?? 0) !== Number(scope.workspaceId ?? 0))
      throw new CoreError('invalid_request', '文件夹层级跨越文件空间，无法压缩')
    treeById.set(Number(row.id), row)
  }
  const containedIds = [...treeById.keys()]
  const containedFiles = containedIds.length ? await client.query<Row & FolderArchiveFileRecord>(
    `SELECT * FROM files WHERE folder_id=ANY($1::integer[]) AND user_id=$2 AND deleted_at IS NULL
     ORDER BY display_name,ext,id`, [containedIds, userId]) : { rows: [] as Array<Row & FolderArchiveFileRecord> }
  const standaloneFiles = selectedFiles.filter((row) => row.folder_id == null || !treeById.has(Number(row.folder_id)))
  const entries: Entry[] = []
  const rootNames = new Set<string>()
  for (const file of standaloneFiles) {
    const name = safeSegment(`${file.display_name}${file.ext ? `.${file.ext}` : ''}`)
    entries.push({ archivePath: nextArchiveName(name, rootNames), kind: 'file', row: file })
  }
  entries.push(...buildFolderArchiveEntries(treeRows.rows, containedFiles.rows, rootNames))
  if (!entries.length) throw new CoreError('invalid_request', '所选内容为空，无法压缩')
  const sourceBytes = entries.reduce((sum, entry) => sum + (entry.kind === 'file' ? Number(entry.row!.size_bytes) : 0), 0)
  if (sourceBytes > MAX_COMPRESS_SOURCE_BYTES) throw new CoreError('conflict', '内容过大，暂不支持在库内压缩')
  const defaultFolderId = selectedFiles[0]?.folder_id == null
    ? (selectedFiles.length ? null : selectedFolders[0]?.parent_id == null ? null : Number(selectedFolders[0]!.parent_id))
    : Number(selectedFiles[0]!.folder_id)
  const defaultName = selectedFiles[0]
    ? `${selectedFiles[0].display_name}${selectedFiles[0].ext ? `.${selectedFiles[0].ext}` : ''}`
    : String(selectedFolders[0]!.name)
  return { entries, scope, defaultFolderId, sourceBytes, defaultName }
}

async function writeZip(entries: Entry[], userId: string, rootPath: string, outputPath: string): Promise<{ size: number; digest: string }> {
  const zip = new JSZip()
  let sourceBytes = 0
  for (const entry of entries) {
    if (entry.kind === 'folder') { zip.folder(entry.archivePath.replace(/\/$/, '')); continue }
    const source = await localPath(rootPath, userId, String(entry.row!.storage_key))
    const info = await lstat(source)
    if (info.isSymbolicLink() || !info.isFile()) throw new CoreError('not_found', '物理文件不存在')
    const sourceMeter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      sourceBytes += chunk.length
      if (sourceBytes > MAX_COMPRESS_SOURCE_BYTES)
        return callback(new CoreError('conflict', '内容过大，暂不支持在库内压缩'))
      callback(null, chunk)
    } })
    zip.file(entry.archivePath, createReadStream(source).pipe(sourceMeter), { binary: true, createFolders: false })
  }
  const hash = createHash('sha256')
  let size = 0
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length
    hash.update(chunk)
    callback(null, chunk)
  } })
  await pipeline(zip.generateNodeStream({
    type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 },
  }), meter, createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }))
  return { size, digest: hash.digest('hex') }
}

function filePayload(row: Row, project: Row | null, folderName: string | null) {
  return fileResponse(row, project, folderName)
}

export interface PostgresFileArchiveOptions {
  storageRoot: string
  fileSyncEnabled: boolean
  defaultLimitBytes: number | null
  publishCreatedFile(event: { ownerId: string; entityId: number; payload: Record<string, unknown>; origin: string | null }): Promise<void>
  publishCreatedBatch(ownerId: string, origin: string | null): Promise<void>
}

async function archiveFiles(pool: Pool, options: PostgresFileArchiveOptions, rawOwner: string,
  input: FileArchiveInput, metadata: WriteRequestMetadata): Promise<unknown> {
  const userId = ownerId(rawOwner)
  const client = await pool.connect()
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'gugu-archive-'))
  const zipPath = path.join(tempDirectory, 'archive.zip')
  let finalPath: string | null = null
  let committed = false
  try {
    await client.query('BEGIN')
    const built = await compressionEntries(client, userId, input)
    const destinationFolderId = input.folderId === undefined ? built.defaultFolderId : input.folderId
    const target = await storageKey(client, userId, built.scope, destinationFolderId, 'placeholder.zip')
    const initialName = input.name?.trim() || built.defaultName || 'archive'
    const displayBase = initialName.toLowerCase().endsWith('.zip') ? initialName.slice(0, -4) : initialName
    if (!displayBase || displayBase.length > 300 || displayBase.includes('/') || displayBase.includes('\\')
      || displayBase === '.' || displayBase === '..') throw new CoreError('invalid_request', '压缩包名称无效')
    const [existingFiles, existingFolders] = await Promise.all([
      client.query<Row>(`SELECT display_name,ext FROM files WHERE user_id=$1 AND project_id IS NOT DISTINCT FROM $2
        AND workspace_directory_id IS NOT DISTINCT FROM $3 AND folder_id IS NOT DISTINCT FROM $4 AND deleted_at IS NULL`,
      [userId, built.scope.projectId, built.scope.workspaceId, destinationFolderId]),
      client.query<{ name: string }>(`SELECT name FROM folders WHERE user_id=$1 AND project_id IS NOT DISTINCT FROM $2
        AND workspace_directory_id IS NOT DISTINCT FROM $3 AND parent_id IS NOT DISTINCT FROM $4 AND deleted_at IS NULL`,
      [userId, built.scope.projectId, built.scope.workspaceId, destinationFolderId]),
    ])
    const occupied = new Set<string>([
      ...existingFiles.rows.map((row) => `${row.display_name}${row.ext ? `.${row.ext}` : ''}`),
      ...existingFolders.rows.map((row) => row.name),
    ])
    const zipName = nextArchiveName(`${displayBase}.zip`, occupied)
    const { displayName, ext } = splitArchiveFilename(zipName)
    const outputKey = target.key.replace(/placeholder\.zip$/, `${safeSegment(displayName)}.${ext}`)
    const remaining = await quotaRemaining(client, userId, options.defaultLimitBytes)
    await writeZip(built.entries, userId, options.storageRoot, zipPath)
    const zipStat = await stat(zipPath)
    if (zipStat.size > remaining) throw new CoreError('conflict', '存储空间不足')
    await lockFileSyncPath(client, userId, outputKey)
    const output = await localPath(options.storageRoot, userId, outputKey)
    const parent = path.dirname(output)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const stageDirectory = await mkdtemp(path.join(parent, '.archive-stage-'))
    const stagedPath = path.join(stageDirectory, 'archive')
    try {
      await copyFile(zipPath, stagedPath)
      await link(stagedPath, output)
      finalPath = output
    }
    finally { await rm(stageDirectory, { recursive: true, force: true }) }
    const displaySize = formatFileSize(zipStat.size)
    const inserted = await client.query<Row>(
      `INSERT INTO files(user_id,display_name,ext,space,project_id,folder_id,workspace_directory_id,
        stage_name,mind_map_id,storage_key,storage_backend,version,size,size_bytes,mime_type,img_width,img_height,
        created_at,updated_at,deleted_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,'',NULL,$8,'local',1,$9,$10,'application/zip',NULL,NULL,
        CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL) RETURNING *`,
      [userId, displayName, ext, built.scope.space, built.scope.projectId, destinationFolderId,
        built.scope.workspaceId, outputKey, displaySize, zipStat.size])
    const row = inserted.rows[0]!
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(output)) hash.update(chunk)
    await recordCanonicalFileChange(client, {
      ownerId: userId, storageRoot: options.storageRoot, storageKey: outputKey,
      observedFingerprint: hash.digest('hex'), enabled: options.fileSyncEnabled,
    })
    await recordQuota(client, userId, zipStat.size, 'archive_compress')
    await client.query('COMMIT')
    committed = true
    const response = filePayload(row, target.project, target.folderName)
    await options.publishCreatedFile({ ownerId: userId, entityId: Number(row.id), payload: response, origin: metadata.clientId }).catch(() => undefined)
    return response
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined)
    if (finalPath && !committed) await rm(finalPath, { force: true }).catch(() => undefined)
    if (error instanceof CoreError) throw error
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new CoreError('conflict', '目标存储路径已被占用，请重试')
    throw new CoreError('storage_error', '压缩文件失败')
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
    client.release()
  }
}

function validateMemberName(name: string, directory: boolean): string {
  const parts = name.split('/')
  const directories = directory ? parts : parts.slice(0, -1)
  const filename = directory ? null : parts.at(-1)
  if (directories.some((part) => part.length > 200)) throw new CoreError('invalid_request', '压缩包损坏')
  if (filename !== null && filename !== undefined) {
    const split = splitArchiveFilename(filename)
    if (split.displayName.length > 300 || split.ext.length > 20) throw new CoreError('invalid_request', '压缩包损坏')
  }
  return name
}

export async function extractZip(zipPath: string, stageDirectory: string): Promise<{ members: ExtractedMember[]; skipped: number }> {
  const unzipper = await import('unzipper')
  const directory = await unzipper.Open.file(zipPath)
  if (directory.files.length > MAX_ARCHIVE_ENTRIES) throw new CoreError('conflict', '压缩包条目过多')
  const members: ExtractedMember[] = []
  let skipped = 0
  let declaredTotal = 0
  const valid = directory.files.map((entry, index) => {
    const archivePath = safeArchivePath(entry.path)
    const isDirectory = entry.type === 'Directory' || entry.path.endsWith('/')
    const mode = Number(entry.externalFileAttributes ?? 0) >>> 16
    const symlink = (mode & 0o170000) === 0o120000
    if ((entry.flags ?? 0) & 0x1) throw new CoreError('invalid_request', '不支持加密压缩包')
    const size = isDirectory || symlink ? 0 : Number(entry.uncompressedSize)
    if (!Number.isSafeInteger(size) || size < 0) throw new CoreError('invalid_request', '压缩包损坏')
    validateMemberName(archivePath, isDirectory)
    declaredTotal += size
    if (symlink) skipped += 1
    return { entry, index, archivePath, isDirectory, symlink, size }
  })
  if (declaredTotal > MAX_EXTRACT_BYTES) throw new CoreError('conflict', '解压内容超过安全上限')
  let total = 0
  for (const item of valid) {
    if (!item.archivePath) continue
    if (item.symlink) continue
    if (item.isDirectory) {
      members.push({ archivePath: item.archivePath, kind: 'folder', size: 0 })
      continue
    }
    const stagedPath = path.join(stageDirectory, `zip-${item.index}`)
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length
      if (total > MAX_EXTRACT_BYTES || total > declaredTotal) return callback(new CoreError('conflict', '解压内容超过安全上限'))
      callback(null, chunk)
    } })
    await pipeline(item.entry.stream(), meter, createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 }))
    const info = await stat(stagedPath)
    if (info.size !== item.size) throw new CoreError('invalid_request', '压缩包损坏')
    members.push({ archivePath: item.archivePath, kind: 'file', size: info.size, stagedPath })
  }
  return { members, skipped }
}

export async function extractTar(archivePath: string, stageDirectory: string, gzip: boolean): Promise<{ members: ExtractedMember[]; skipped: number }> {
  const parser = new tar.Parser({ strict: true })
  const members: ExtractedMember[] = []
  let skipped = 0
  let count = 0
  let total = 0
  let actualTotal = 0
  let failure: unknown
  const entryTasks: Promise<void>[] = []
  const done = new Promise<void>((resolve) => {
    parser.on('error', (error) => { failure = error })
    parser.on('end', resolve)
    parser.on('entry', (entry) => {
      const index = count++
      if (count > MAX_ARCHIVE_ENTRIES) {
        entry.resume()
        parser.abort(new CoreError('conflict', '压缩包条目过多'))
        return
      }
      let memberName: string
      try { memberName = safeArchivePath(entry.path) }
      catch (error) { entry.resume(); parser.abort(error as Error); return }
      const directory = entry.type === 'Directory'
      const file = entry.type === 'File'
      const supported = directory || file
      const size = file ? Number(entry.size) : 0
      try {
        if (!Number.isSafeInteger(size) || size < 0) throw new CoreError('invalid_request', '压缩包损坏')
        if (supported && memberName) validateMemberName(memberName, directory)
        total += size
        if (total > MAX_EXTRACT_BYTES) throw new CoreError('conflict', '解压内容超过安全上限')
      } catch (error) { entry.resume(); parser.abort(error as Error); return }
      if (!supported || !memberName) {
        skipped += supported ? 0 : 1
        entry.resume()
        return
      }
      if (directory) {
        members.push({ archivePath: memberName, kind: 'folder', size: 0 })
        entry.resume()
        return
      }
      const stagedPath = path.join(stageDirectory, `tar-${index}`)
      let actualFileTotal = 0
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        const actual = chunk.length
        actualFileTotal += actual
        actualTotal += actual
        if (actualFileTotal > size || actualTotal > total || actualTotal > MAX_EXTRACT_BYTES)
          return callback(new CoreError('conflict', '解压内容超过安全上限'))
        callback(null, chunk)
      } })
      const entryTask = pipeline(entry, meter, createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 }))
        .then(async () => {
          const info = await stat(stagedPath)
          if (info.size !== size) throw new CoreError('invalid_request', '压缩包损坏')
          members.push({ archivePath: memberName, kind: 'file', size: info.size, stagedPath })
        })
        .catch((error) => { failure = error; parser.abort(error as Error) })
      entryTasks.push(entryTask)
    })
  })
  const input = createReadStream(archivePath)
  if (gzip) await pipeline(input, createGunzip(), parser)
  else await pipeline(input, parser)
  await done
  await Promise.all(entryTasks)
  if (failure) throw failure
  return { members, skipped }
}

async function occupiedNames(client: PoolClient, userId: string, scope: Scope, folderId: number | null): Promise<Set<string>> {
  const [files, folders] = await Promise.all([
    client.query<Row>(`SELECT display_name,ext FROM files WHERE user_id=$1 AND project_id IS NOT DISTINCT FROM $2
      AND workspace_directory_id IS NOT DISTINCT FROM $3 AND folder_id IS NOT DISTINCT FROM $4 AND deleted_at IS NULL`,
    [userId, scope.projectId, scope.workspaceId, folderId]),
    client.query<{ name: string }>(`SELECT name FROM folders WHERE user_id=$1 AND project_id IS NOT DISTINCT FROM $2
      AND workspace_directory_id IS NOT DISTINCT FROM $3 AND parent_id IS NOT DISTINCT FROM $4 AND deleted_at IS NULL`,
    [userId, scope.projectId, scope.workspaceId, folderId]),
  ])
  return new Set([
    ...files.rows.map((row) => `${row.display_name}${row.ext ? `.${row.ext}` : ''}`),
    ...folders.rows.map((row) => row.name),
  ])
}

function archiveRoot(members: ExtractedMember[]): string | null {
  const visible = members.filter((member) => member.archivePath)
  const roots = new Set(visible.map((member) => member.archivePath.split('/')[0]))
  if (roots.size !== 1) return null
  const root = [...roots][0]!
  if (visible.some((member) => member.archivePath === root && member.kind !== 'folder')) return null
  return root
}

function validateFolderName(value: string): string {
  if (!value || value.length > 200 || value === '.' || value === '..'
    || value.includes('/') || value.includes('\\') || /^[a-zA-Z]:/.test(value) || value.includes('\0'))
    throw new CoreError('invalid_request', '解压文件夹名称无效')
  return value
}

async function unarchiveFiles(pool: Pool, options: PostgresFileArchiveOptions, rawOwner: string,
  input: FileUnarchiveInput, metadata: WriteRequestMetadata): Promise<unknown> {
  const userId = ownerId(rawOwner)
  const client = await pool.connect()
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'gugu-unarchive-'))
  const localArchive = path.join(tempDirectory, 'source.archive')
  const stageDirectory = path.join(tempDirectory, 'members')
  const createdFilePaths: string[] = []
  const createdFolderPaths: string[] = []
  let committed = false
  try {
    await mkdir(stageDirectory, { mode: 0o700 })
    await client.query('BEGIN')
    const sourceResult = await client.query<Row>(
      'SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE', [input.fileId, userId])
    const source = sourceResult.rows[0]
    if (!source) throw new CoreError('not_found', '压缩包不存在')
    const scope = scopeOf(source)
    const format = supportedArchiveFormat(String(source.display_name), String(source.ext))
    if (!format) throw new CoreError('invalid_request', '不支持的压缩格式')
    const hint = input.format?.toLowerCase().replace(/^\./, '')
    if (hint && !['zip', 'tar', 'tar.gz', 'tgz'].includes(hint))
      throw new CoreError('invalid_request', '不支持的压缩格式')
    const targetFolderId = input.folderId === undefined
      ? (source.folder_id == null ? null : Number(source.folder_id)) : input.folderId
    const targetFolder = await folderPath(client, userId, targetFolderId, scope)
    const archiveSource = await localPath(options.storageRoot, userId, String(source.storage_key))
    await copyFile(archiveSource, localArchive)
    const header = Buffer.alloc(4)
    const handle = await import('node:fs/promises').then((fs) => fs.open(localArchive, 'r'))
    try { await handle.read(header, 0, header.length, 0) } finally { await handle.close() }
    const signature = header.subarray(0, 2).toString('hex')
    const actualFormat = signature === '504b' ? 'zip' : 'tar'
    const gzip = signature === '1f8b'
    if (hint && ((hint === 'zip') !== (actualFormat === 'zip')))
      throw new CoreError('invalid_request', '不支持的压缩格式')
    if (format === 'zip' && actualFormat !== 'zip' && !hint) {
      // Python accepts valid TAR payloads even when the file extension says ZIP.
    }
    const remaining = await quotaRemaining(client, userId, options.defaultLimitBytes)
    const extracted = actualFormat === 'zip'
      ? await extractZip(localArchive, stageDirectory)
      : await extractTar(localArchive, stageDirectory, gzip)
    const totalBytes = extracted.members.reduce((sum, member) => sum + (member.kind === 'file' ? member.size : 0), 0)
    if (totalBytes > MAX_EXTRACT_BYTES || totalBytes > remaining)
      throw new CoreError('conflict', '解压内容超过可用存储空间或安全上限')

    const folderIds = new Map<string, number | null>()
    const folderNames = new Map<number | null, Set<string>>()
    const createdFolderIds: number[] = []
    const ensureFolder = async (archivePath: string): Promise<number | null> => {
      const normalized = archivePath.replace(/\/$/, '')
      if (!normalized) return targetFolderId
      if (folderIds.has(normalized)) return folderIds.get(normalized) ?? null
      const parts = normalized.split('/')
      let parentId = targetFolderId
      let prefix = ''
      for (const part of parts) {
        prefix = prefix ? `${prefix}/${part}` : part
        if (folderIds.has(prefix)) {
          parentId = folderIds.get(prefix) ?? null
          continue
        }
        let occupied = folderNames.get(parentId)
        if (!occupied) { occupied = await occupiedNames(client, userId, scope, parentId); folderNames.set(parentId, occupied) }
        const chosen = nextArchiveName(safeSegment(part), occupied, true)
        const inserted = await client.query<Row>(
          `INSERT INTO folders(user_id,project_id,workspace_directory_id,parent_id,name,deleted_at)
           VALUES($1,$2,$3,$4,$5,NULL) RETURNING id`,
          [userId, scope.projectId, scope.workspaceId, parentId, chosen])
        const id = Number(inserted.rows[0]!.id)
        const directoryTarget = await storageKey(client, userId, scope, parentId, safeSegment(chosen))
        const directoryPath = await localPath(options.storageRoot, userId, directoryTarget.key)
        await mkdir(directoryPath, { recursive: true, mode: 0o700 })
        createdFolderPaths.push(directoryPath)
        createdFolderIds.push(id)
        folderIds.set(prefix, id)
        parentId = id
      }
      return parentId
    }

    let members = extracted.members.filter((member) => member.archivePath)
    const customName = input.folderName == null ? null : validateFolderName(input.folderName)
    if (customName) {
      const wrapperRoot = archiveRoot(members)
      if (wrapperRoot) {
        members = members.flatMap((member) => {
          if (member.archivePath === wrapperRoot && member.kind === 'folder') return []
          const relative = member.archivePath.startsWith(`${wrapperRoot}/`)
            ? member.archivePath.slice(wrapperRoot.length + 1) : member.archivePath
          return [{ ...member, archivePath: relative }]
        })
      }
      await ensureFolder(customName)
      for (const member of members) member.archivePath = `${customName}/${member.archivePath}`
    }

    let actualFileCount = 0
    const skippedCount = extracted.skipped
    const createdFileIds: number[] = []
    for (const member of members) {
      if (member.kind === 'folder') {
        await ensureFolder(member.archivePath)
        continue
      }
      const parts = member.archivePath.split('/')
      const filename = parts.pop()!
      const parentId = parts.length ? await ensureFolder(parts.join('/')) : targetFolderId
      const stemExt = splitArchiveFilename(filename)
      if (!stemExt.displayName || stemExt.displayName.length > 300 || stemExt.ext.length > 20)
        throw new CoreError('invalid_request', '压缩包损坏')
      let occupied = folderNames.get(parentId)
      if (!occupied) { occupied = await occupiedNames(client, userId, scope, parentId); folderNames.set(parentId, occupied) }
      let name = nextArchiveName(`${stemExt.displayName}${stemExt.ext ? `.${stemExt.ext}` : ''}`, occupied)
      let splitName = splitArchiveFilename(name)
      let keyParts = await storageKey(client, userId, scope, parentId,
        `${safeSegment(splitName.displayName)}${splitName.ext ? `.${safeSegment(splitName.ext)}` : ''}`)
      let filePath = await localPath(options.storageRoot, userId, keyParts.key)
      let collisions = 0
      while (await lstat(filePath).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false
        throw error
      })) {
        collisions += 1
        name = nextArchiveName(name, occupied)
        splitName = splitArchiveFilename(name)
        keyParts = await storageKey(client, userId, scope, parentId,
          `${safeSegment(splitName.displayName)}${splitName.ext ? `.${safeSegment(splitName.ext)}` : ''}`)
        filePath = await localPath(options.storageRoot, userId, keyParts.key)
        if (collisions > 10_000) throw new CoreError('conflict', '解压文件名称冲突过多')
      }
      const parentDirectory = path.dirname(filePath)
      await mkdir(parentDirectory, { recursive: true, mode: 0o700 })
      const stageDirectory = await mkdtemp(path.join(parentDirectory, '.extract-stage-'))
      const stagedPath = path.join(stageDirectory, 'content')
      try {
        await copyFile(member.stagedPath!, stagedPath)
        await link(stagedPath, filePath)
        createdFilePaths.push(filePath)
        await unlink(stagedPath)
      }
      finally { await rm(stageDirectory, { recursive: true, force: true }) }
      const fileStat = await stat(filePath)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(filePath)) hash.update(chunk)
      const size = fileStat.size
      const inserted = await client.query<Row>(
        `INSERT INTO files(user_id,display_name,ext,space,project_id,folder_id,workspace_directory_id,
          stage_name,mind_map_id,storage_key,storage_backend,version,size,size_bytes,mime_type,img_width,img_height,
          created_at,updated_at,deleted_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,'',NULL,$8,'local',1,$9,$10,$11,NULL,NULL,
          CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL) RETURNING id`,
        [userId, splitName.displayName, splitName.ext, scope.space, scope.projectId, parentId, scope.workspaceId,
          keyParts.key, formatFileSize(size), size, archiveMimeType(filename)])
      const id = Number(inserted.rows[0]!.id)
      await recordCanonicalFileChange(client, {
        ownerId: userId, storageRoot: options.storageRoot, storageKey: keyParts.key,
        observedFingerprint: hash.digest('hex'), enabled: options.fileSyncEnabled,
      })
      await recordQuota(client, userId, size, 'archive_extract')
      createdFileIds.push(id)
      actualFileCount += 1
    }
    const folderCount = createdFolderIds.length
    const result = {
      created_count: actualFileCount + folderCount,
      file_count: actualFileCount,
      folder_count: folderCount,
      skipped_count: skippedCount,
      rejected_count: 0,
      file_ids: createdFileIds,
      folder_ids: createdFolderIds,
    }
    await client.query('COMMIT')
    committed = true
    if (result.created_count) await options.publishCreatedBatch(userId, metadata.clientId).catch(() => undefined)
    return result
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK').catch(() => undefined)
      for (const item of createdFilePaths) await rm(item, { force: true }).catch(() => undefined)
      for (const item of [...createdFolderPaths].reverse()) await rm(item, { recursive: false, force: true }).catch(() => undefined)
    }
    if (error instanceof CoreError) throw error
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new CoreError('conflict', '目标存储路径已被占用，请重试')
    throw new CoreError('invalid_request', '压缩包损坏')
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
    client.release()
  }
}

export function createPostgresFileArchiveOperations(pool: Pool, options: PostgresFileArchiveOptions): FileArchiveOperations {
  return {
    archive: (userId, input, metadata) => archiveFiles(pool, options, userId, input, metadata),
    unarchive: (userId, input, metadata) => unarchiveFiles(pool, options, userId, input, metadata),
  }
}
