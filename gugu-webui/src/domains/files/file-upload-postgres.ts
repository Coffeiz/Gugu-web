import { CoreError } from '@gugu/core'
import { copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { isPathWithin } from '../../adapters/path-safety.js'
import type { FileUploadInput, FileUploadOperations, StagedUpload } from './file-upload.js'
import { normalizeFileOwnerId } from './file-owner.js'
import { formatFileSize } from './file-size.js'
import { ensureRegistrationFileLibraryQuota, updateFileStorageQuota } from './persistence/storage-quota.js'

const FILE_LIBRARY = 'file_library'
const UNDO_CONTENT_MAX = 64 * 1024 * 1024

interface Target {
  project: { id: number; name: string; color: string | null; year: string; month: string } | null
  workspaceName: string | null
  mindMap: { id: number; title: string } | null
  folderPath: string[]
  folderName: string | null
}

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
  size: string
  size_bytes: number | string
  mime_type: string | null
  img_width: number | string | null
  img_height: number | string | null
  version: number | string
  created_at: Date | string
}

interface FolderTargetRow extends QueryResultRow {
  id: number | string
  parent_id: number | string | null
  name: string
  project_id: number | string | null
  workspace_directory_id: number | string | null
  user_id: string
}

function safeSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_')
}

function parseName(value: string): { displayName: string; ext: string } {
  const base = path.basename(value).replace(/[\0\r\n]/g, '').trim() || 'file'
  const dot = base.lastIndexOf('.')
  const rawExt = dot > 0 ? base.slice(dot + 1) : ''
  const displayName = safeSegment(dot > 0 ? base.slice(0, dot) : base).slice(0, 300) || 'file'
  const ext = safeSegment(rawExt).slice(0, 20).toLowerCase()
  return { displayName, ext }
}

async function storagePath(rootPath: string, key: string): Promise<{ root: string; target: string }> {
  const segments = key.split('/')
  if (segments.length < 2 || segments.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')))
    throw new CoreError('storage_error', '文件存储位置无效')
  const root = await realpath(rootPath).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    await mkdir(rootPath, { recursive: true, mode: 0o700 })
    return realpath(rootPath)
  })
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

function validateUploadScope(input: FileUploadInput): void {
  if (input.projectId !== null && input.workspaceDirectoryId !== null)
    throw new CoreError('invalid_request', '项目与 Workspace 目录不能同时指定')
  if (input.space === 'project') {
    if (input.projectId === null) throw new CoreError('invalid_request', '项目文件必须指定项目')
  } else if (input.projectId !== null) throw new CoreError('invalid_request', '当前空间不能指定项目')
  if (input.space === 'workspace') {
    if (input.workspaceDirectoryId === null) throw new CoreError('invalid_request', 'Workspace 文件必须指定目录')
  } else if (input.workspaceDirectoryId !== null) throw new CoreError('invalid_request', '当前空间不能指定 Workspace 目录')
  if (input.space === 'mind') {
    if (input.mindMapId === null) throw new CoreError('invalid_request', '思维文件必须指定思维导图')
  } else if (input.mindMapId !== null) throw new CoreError('invalid_request', '当前空间不能指定思维导图')
}

async function loadProjectTarget(client: PoolClient, userId: string, projectId: number | null): Promise<Target['project']> {
  if (projectId === null) return null
  const result = await client.query<QueryResultRow & { id: string | number; name: string; color: string | null; year: string; month: string }>(
    `SELECT id,name,color,COALESCE(to_char(start_date,'YYYY'),to_char(created_at,'YYYY')) AS year,
       COALESCE(to_char(start_date,'MM'),to_char(created_at,'MM')) AS month
       FROM projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [projectId, userId],
  )
  const row = result.rows[0]
  if (!row) throw new CoreError('not_found', '项目不存在')
  return { id: Number(row.id), name: row.name, color: row.color, year: row.year, month: row.month }
}

async function loadFolderTarget(
  client: PoolClient, userId: string, input: FileUploadInput,
): Promise<{ folderPath: string[]; folderName: string | null }> {
  const folderPath: string[] = []
  let folderName: string | null = null
  if (input.folderId !== null) {
    let current: number | null = input.folderId
    const seen = new Set<number>()
    while (current !== null && folderPath.length < 64) {
      if (seen.has(current)) throw new CoreError('conflict', '文件夹层级存在循环')
      seen.add(current)
      const result: { rows: FolderTargetRow[] } = await client.query<FolderTargetRow>(
        `SELECT id,parent_id,name,project_id,workspace_directory_id,user_id::text AS user_id
          FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [current, userId])
      const row: FolderTargetRow | undefined = result.rows[0]
      if (!row) throw new CoreError('not_found', '文件夹不存在')
      const projectId = row.project_id === null ? null : Number(row.project_id)
      const workspaceId = row.workspace_directory_id === null ? null : Number(row.workspace_directory_id)
      if (projectId !== input.projectId || workspaceId !== input.workspaceDirectoryId)
        throw new CoreError('invalid_request', '目标文件夹不属于目标空间')
      folderName ??= row.name
      folderPath.unshift(safeSegment(row.name))
      current = row.parent_id === null ? null : Number(row.parent_id)
    }
    if (current !== null) throw new CoreError('invalid_request', '文件夹层级过深')
  }
  return { folderPath, folderName }
}

async function resolveTarget(client: PoolClient, userId: string, input: FileUploadInput): Promise<Target> {
  validateUploadScope(input)
  const project = await loadProjectTarget(client, userId, input.projectId)
  let workspaceName: string | null = null
  if (input.workspaceDirectoryId !== null) {
    const result = await client.query<{ directory_name: string }>(
      'SELECT directory_name FROM workspace_directories WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
      [input.workspaceDirectoryId, userId],
    )
    workspaceName = result.rows[0]?.directory_name ?? null
    if (!workspaceName) throw new CoreError('not_found', 'Workspace 不存在')
  }
  let mindMap: Target['mindMap'] = null
  if (input.mindMapId !== null) {
    const result = await client.query<{ id: number | string; title: string }>(
      'SELECT id,title FROM mind_maps WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
      [input.mindMapId, userId],
    )
    const row = result.rows[0]
    if (!row) throw new CoreError('not_found', '思维导图不存在')
    mindMap = { id: Number(row.id), title: row.title }
  }
  return { project, workspaceName, mindMap, ...await loadFolderTarget(client, userId, input) }
}

async function capacity(client: PoolClient, userId: string, overwriteFileId: number | null, defaultLimit: number | null): Promise<number | null> {
  const userResult = await client.query<{ storage_limit_bytes: string | number | null }>(
    'SELECT storage_limit_bytes FROM users WHERE id=$1', [userId],
  )
  if (!userResult.rowCount) throw new CoreError('not_found', '用户不存在')
  const rawLimit = userResult.rows[0]!.storage_limit_bytes
  const limit = rawLimit === null ? defaultLimit : Number(rawLimit)
  if (limit === null || limit === -1) return null
  const ledger = await client.query<{ used_bytes: string | number; reserved_bytes: string | number }>(
    `SELECT used_bytes,reserved_bytes FROM storage_quota_ledgers
     WHERE user_id=$1 AND category=$2 AND status='active'`, [userId, FILE_LIBRARY],
  )
  const row = ledger.rows[0]
  if (!row) throw new CoreError('busy', '存储配额账本尚未就绪，请稍后重试')
  let reclaimable = 0
  if (overwriteFileId !== null) {
    const existing = await client.query<{ size_bytes: string | number }>(
      'SELECT size_bytes FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [overwriteFileId, userId],
    )
    reclaimable = Number(existing.rows[0]?.size_bytes ?? 0)
  }
  return Math.max(Number(limit) - Number(row.used_bytes) - Number(row.reserved_bytes) + reclaimable, 0)
}

function keyFor(userId: string, input: FileUploadInput, target: Target, displayName: string, ext: string): string {
  const filename = `${safeSegment(displayName)}${ext ? `.${ext}` : ''}`
  const folder = target.folderPath.join('/')
  if (input.space === 'project')
    return [userId, '项目文件', target.project!.year, target.project!.month,
      `${safeSegment(target.project!.name)} #${target.project!.id}`, folder, filename].filter(Boolean).join('/')
  if (input.space === 'workspace')
    return [userId, 'workspace', safeSegment(target.workspaceName!), folder, filename].filter(Boolean).join('/')
  if (input.space === 'mind') return [userId, '思维', `${safeSegment(target.mindMap!.title)} #${target.mindMap!.id}`, filename].join('/')
  if (input.space === 'asset') return [userId, '素材板', filename].join('/')
  return [userId, '个人文件', folder, filename].filter(Boolean).join('/')
}

function fileResponse(row: FileRow, target: Target) {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : `${row.created_at.replace(/Z?$/, 'Z')}`
  return {
    id: Number(row.id), displayName: row.display_name, ext: row.ext, space: row.space,
    workspaceDirectoryId: row.workspace_directory_id === null ? null : Number(row.workspace_directory_id),
    projectId: row.project_id === null ? null : Number(row.project_id),
    projectName: target.project?.name ?? null,
    projectColor: target.project?.color?.match(/#[0-9a-fA-F]{3,6}/)?.[0] ?? target.project?.color ?? null,
    stageName: row.stage_name,
    folderId: row.folder_id === null ? null : Number(row.folder_id), folderName: target.folderName,
    mindMapId: row.mind_map_id === null ? null : Number(row.mind_map_id),
    size: row.size, sizeBytes: Number(row.size_bytes), mimeType: row.mime_type,
    createdAt, deletedAt: null, imgWidth: row.img_width === null ? null : Number(row.img_width),
    imgHeight: row.img_height === null ? null : Number(row.img_height), version: Number(row.version),
  }
}

async function insertUndo(
  client: PoolClient, userId: string, contextId: string | null, action: 'create' | 'overwrite',
  row: FileRow, before: FileRow | null, artifacts: Record<string, unknown>, operationId = `op-${randomUUID().replaceAll('-', '')}`,
): Promise<void> {
  const context = contextId?.trim().slice(0, 128)
  if (!context) return
  const ref = `file:${row.id}`
  const snapshot = (file: FileRow) => ({
    id: Number(file.id), display_name: file.display_name, ext: file.ext, space: file.space,
    project_id: file.project_id === null ? null : Number(file.project_id),
    folder_id: file.folder_id === null ? null : Number(file.folder_id),
    workspace_directory_id: file.workspace_directory_id === null ? null : Number(file.workspace_directory_id),
    stage_name: file.stage_name, mind_map_id: file.mind_map_id === null ? null : Number(file.mind_map_id),
    storage_key: file.storage_key, version: Number(file.version), size: file.size,
    size_bytes: Number(file.size_bytes), mime_type: file.mime_type,
    img_width: file.img_width === null ? null : Number(file.img_width),
    img_height: file.img_height === null ? null : Number(file.img_height), deleted_at: null,
  })
  await client.query(
    `UPDATE undo_operations SET status='expired',failure_code='redo_cleared_by_new_operation'
     WHERE user_id=$1 AND undo_context_id=$2 AND actor_type='web' AND status='undone'`, [userId, context],
  )
  await client.query(
    `INSERT INTO undo_operations (id,user_id,undo_context_id,group_id,resource,action,target_refs,
       before_state,after_state,base_versions,artifact_refs,actor_type,status,created_at,expires_at,undone_at,failure_code)
     VALUES ($1,$2,$3,$4,'files',$5,$6::json,$7::json,$8::json,$9::json,$10::json,'web','active',
       CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '30 days',NULL,NULL)`,
    [operationId, userId, context, `group-${randomUUID().replaceAll('-', '')}`,
      action, JSON.stringify([{ kind: 'file', id: Number(row.id) }]),
      JSON.stringify({ items: before ? { [ref]: snapshot(before) } : {} }),
      JSON.stringify({ items: { [ref]: snapshot(row) } }),
      JSON.stringify({ [ref]: { version: before ? Number(before.version) : 0 } }), JSON.stringify(artifacts)],
  )
}

interface UploadStoreOptions {
  storageRoot: string
  defaultLimitBytes: number | null
  publishChanged(event: {
    ownerId: string; operation: 'create' | 'update'; entityId: number
    payload: Record<string, unknown>; origin: string | null
  }): Promise<void>
}

interface UploadStoreState {
  finalPath: string | null
  createdDestinations: string[]
  rollbackPath: string | null
  replacedDestination: boolean
  stagingDirectories: string[]
  createdArtifacts: string[]
}

function uploadTooLarge(): Error {
  return Object.assign(new Error('存储空间已满，无法上传'), { statusCode: 413 })
}

function validateOverwriteTarget(before: FileRow, upload: StagedUpload, displayName: string, ext: string): void {
  const { input } = upload
  if (before.space !== input.space
    || (before.project_id === null ? null : Number(before.project_id)) !== input.projectId
    || (before.folder_id === null ? null : Number(before.folder_id)) !== input.folderId
    || (before.workspace_directory_id === null ? null : Number(before.workspace_directory_id)) !== input.workspaceDirectoryId
    || (before.mind_map_id === null ? null : Number(before.mind_map_id)) !== input.mindMapId
    || before.display_name !== displayName || before.ext.toLowerCase() !== ext)
    throw new CoreError('invalid_request', '覆盖目标与上传文件不匹配')
}

async function loadOverwriteTarget(client: PoolClient, userId: string, upload: StagedUpload): Promise<FileRow | null> {
  if (upload.input.onConflict !== 'overwrite') return null
  const result = await client.query<FileRow>(
    'SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE',
    [upload.input.overwriteFileId, userId],
  )
  const row = result.rows[0]
  if (!row) throw new CoreError('not_found', '要覆盖的文件不存在')
  return row
}

async function stageForStorage(sourcePath: string, destination: string, state: UploadStoreState): Promise<string> {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  const stagingDirectory = await mkdtemp(path.join(path.dirname(destination), '.upload-stage-'))
  state.stagingDirectories.push(stagingDirectory)
  const stagedPath = path.join(stagingDirectory, 'content')
  await copyFile(sourcePath, stagedPath)
  return stagedPath
}

async function storeOverwrite(
  client: PoolClient, options: UploadStoreOptions, state: UploadStoreState,
  userId: string, upload: StagedUpload, metadata: { undoContextId: string | null },
  target: Target, before: FileRow,
): Promise<FileRow> {
  const destination = (await storagePath(options.storageRoot, before.storage_key)).target
  state.finalPath = destination
  const stagedPath = await stageForStorage(upload.path, destination, state)
  const undoContext = metadata.undoContextId && upload.sizeBytes <= UNDO_CONTENT_MAX
    ? metadata.undoContextId
    : null
  let artifactRefs: Record<string, unknown> = {}
  let undoId: string | undefined
  if (undoContext !== null) {
    undoId = `op-${randomUUID().replaceAll('-', '')}`
    const prefix = `${userId}/.undo/${undoId}/file-${before.id}`
    const beforeArtifact = await storagePath(options.storageRoot, `${prefix}/before`)
    const afterArtifact = await storagePath(options.storageRoot, `${prefix}/after`)
    await mkdir(path.dirname(beforeArtifact.target), { recursive: true, mode: 0o700 })
    state.createdArtifacts.push(beforeArtifact.target, afterArtifact.target)
    await copyFile(destination, beforeArtifact.target)
    await copyFile(stagedPath, afterArtifact.target)
    artifactRefs = { [`file:${before.id}`]: { before_key: `${prefix}/before`, after_key: `${prefix}/after` } }
  }
  const updated = await client.query<FileRow>(
    `UPDATE files SET size=$3,size_bytes=$4,mime_type=$5,img_width=$6,img_height=$7,
       version=version+1,updated_at=CURRENT_TIMESTAMP
     WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING *`,
    [before.id, userId, formatFileSize(upload.sizeBytes), upload.sizeBytes, upload.mimeType,
      upload.imgWidth, upload.imgHeight],
  )
  const row = updated.rows[0]
  if (!row) throw new CoreError('not_found', '要覆盖的文件不存在')
  state.rollbackPath = `${stagedPath}.old`
  await rename(destination, state.rollbackPath)
  await rename(stagedPath, destination)
  state.replacedDestination = true
  if (undoContext) await insertUndo(client, userId, undoContext, 'overwrite', row, before, artifactRefs, undoId)
  await updateFileStorageQuota(
    client,
    userId,
    Number(row.id),
    upload.sizeBytes - Number(before.size_bytes),
    'file_upload',
    `file-upload:${row.id}:${randomUUID().replaceAll('-', '')}`,
  )
  return row
}

async function availableStorageKey(
  client: PoolClient, options: UploadStoreOptions, userId: string, baseKey: string, displayName: string, ext: string,
): Promise<{ key: string; name: string }> {
  let suffix = 0
  while (true) {
    const name = suffix === 0 ? displayName : `${displayName}(${suffix})`
    const key = suffix === 0 ? baseKey : `${baseKey.slice(0, baseKey.lastIndexOf('/') + 1)}${safeSegment(name)}${ext ? `.${ext}` : ''}`
    const disk = await storagePath(options.storageRoot, key)
    const exists = await stat(disk.target).then(
      () => true,
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? false : Promise.reject(error),
    )
    const collision = await client.query('SELECT 1 FROM files WHERE user_id=$1 AND storage_key=$2 AND deleted_at IS NULL', [userId, key])
    if (!exists && !collision.rowCount) return { key, name }
    suffix++
  }
}

async function storeNewFile(
  client: PoolClient, options: UploadStoreOptions, state: UploadStoreState,
  userId: string, upload: StagedUpload, metadata: { undoContextId: string | null },
  target: Target, displayName: string, ext: string, quotaOperation: 'file_upload' | 'onboarding_seed' = 'file_upload',
): Promise<FileRow> {
  const baseKey = keyFor(userId, upload.input, target, displayName, ext)
  const { key, name } = await availableStorageKey(client, options, userId, baseKey, displayName, ext)
  const destination = (await storagePath(options.storageRoot, key)).target
  const stagedPath = await stageForStorage(upload.path, destination, state)
  const inserted = await client.query<FileRow>(
    `INSERT INTO files (user_id,display_name,ext,space,workspace_directory_id,project_id,folder_id,
       stage_name,mind_map_id,storage_key,storage_backend,version,size,size_bytes,mime_type,
       img_width,img_height,created_at,updated_at,deleted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'local',1,$11,$12,$13,$14,$15,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL)
     RETURNING *`,
    [userId, name, ext, upload.input.space, upload.input.workspaceDirectoryId,
      upload.input.space === 'project' ? upload.input.projectId : null, upload.input.folderId,
      upload.input.stageName, upload.input.space === 'mind' ? upload.input.mindMapId : null,
      key, formatFileSize(upload.sizeBytes), upload.sizeBytes, upload.mimeType,
      upload.imgWidth, upload.imgHeight],
  )
  const row = inserted.rows[0]
  if (!row) throw new CoreError('storage_error', '文件记录未能创建')
  await rename(stagedPath, destination)
  state.finalPath = destination
  state.createdDestinations.push(destination)
  state.replacedDestination = true
  if (metadata.undoContextId && upload.sizeBytes <= UNDO_CONTENT_MAX)
    await insertUndo(client, userId, metadata.undoContextId, 'create', row, null, {})
  await updateFileStorageQuota(
    client,
    userId,
    Number(row.id),
    upload.sizeBytes,
    quotaOperation,
    `${quotaOperation}:${row.id}:${randomUUID().replaceAll('-', '')}`,
  )
  return row
}

export interface RegistrationSeedLocalFile {
  space: 'project' | 'personal'
  displayName: string
  ext: string
  mimeType: string
  data: Uint8Array
}

/**
 * Writes onboarding files through the same Local path, collision, metadata and quota rules
 * as regular uploads, while letting the onboarding adapter keep all rows in its transaction.
 */
export function createPostgresRegistrationSeedFileWriter(storageRoot: string, defaultLimitBytes: number | null = null) {
  return async function writeSeedFiles(
    client: PoolClient,
    userId: string,
    projectId: number,
    files: readonly RegistrationSeedLocalFile[],
  ): Promise<{ fileIds: number[]; rollback(): Promise<void>; finalize(): Promise<void> }> {
    const state: UploadStoreState = {
      finalPath: null, createdDestinations: [], rollbackPath: null, replacedDestination: false,
      stagingDirectories: [], createdArtifacts: [],
    }
    const tempDirectory = await mkdtemp(path.join(tmpdir(), 'gugu-onboarding-seed-'))
    const options: UploadStoreOptions = {
      storageRoot,
      defaultLimitBytes,
      async publishChanged() {},
    }
    try {
      await ensureRegistrationFileLibraryQuota(client, userId, defaultLimitBytes)
      const fileIds: number[] = []
      for (const [index, file] of files.entries()) {
        const tempPath = path.join(tempDirectory, `seed-${index}`)
        await writeFile(tempPath, file.data, { mode: 0o600, flag: 'wx' })
        const input: FileUploadInput = {
          space: file.space, projectId: file.space === 'project' ? projectId : null,
          folderId: null, workspaceDirectoryId: null, stageName: '', mindMapId: null,
          onConflict: 'keep_both', overwriteFileId: null,
        }
        const upload: StagedUpload = {
          input, originalName: `${file.displayName}.${file.ext}`, mimeType: file.mimeType,
          path: tempPath, sizeBytes: file.data.byteLength, sha256: '', imgWidth: null, imgHeight: null,
        }
        const target = await resolveTarget(client, userId, input)
        const allowedBytes = await capacity(client, userId, null, defaultLimitBytes)
        if (allowedBytes !== null && upload.sizeBytes > allowedBytes) throw uploadTooLarge()
        const { displayName, ext } = parseName(upload.originalName)
        const row = await storeNewFile(client, options, state, userId, upload, { undoContextId: null }, target,
          displayName, ext, 'onboarding_seed')
        fileIds.push(Number(row.id))
      }
      return {
        fileIds,
        async rollback() {
          for (const destination of state.createdDestinations) await rm(destination, { force: true }).catch(() => undefined)
          await cleanup()
        },
        async finalize() { await cleanup() },
      }
    } catch (error) {
      for (const destination of state.createdDestinations) await rm(destination, { force: true }).catch(() => undefined)
      await cleanup()
      throw error
    }

    async function cleanup() {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined)
      for (const directory of state.stagingDirectories)
        await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export function createPostgresFileUploadOperations(
  pool: Pool,
  options: UploadStoreOptions,
): FileUploadOperations {
  return {
    async getUploadCapacity(rawOwnerId, input) {
      const userId = normalizeFileOwnerId(rawOwnerId)
      const client = await pool.connect()
      try {
        await resolveTarget(client, userId, input)
        return await capacity(client, userId, input.onConflict === 'overwrite' ? input.overwriteFileId : null, options.defaultLimitBytes)
      } finally { client.release() }
    },

    async store(rawOwnerId, upload: StagedUpload, metadata) {
      const userId = normalizeFileOwnerId(rawOwnerId)
      const { displayName, ext } = parseName(upload.originalName)
      const client = await pool.connect()
      const state: UploadStoreState = {
        finalPath: null, createdDestinations: [], rollbackPath: null, replacedDestination: false,
        stagingDirectories: [], createdArtifacts: [],
      }
      let committed = false
      try {
        await client.query('BEGIN')
        const target = await resolveTarget(client, userId, upload.input)
        const before = await loadOverwriteTarget(client, userId, upload)
        if (before) validateOverwriteTarget(before, upload, displayName, ext)
        const uploadCapacity = await capacity(client, userId, before ? Number(before.id) : null, options.defaultLimitBytes)
        if (uploadCapacity !== null && upload.sizeBytes > uploadCapacity) throw uploadTooLarge()
        const row = before
          ? await storeOverwrite(client, options, state, userId, upload, metadata, target, before)
          : await storeNewFile(client, options, state, userId, upload, metadata, target, displayName, ext)
        await client.query('COMMIT')
        committed = true
        if (state.rollbackPath) await rm(state.rollbackPath, { force: true })
        const response = fileResponse(row, target)
        await options.publishChanged({ ownerId: userId, operation: before ? 'update' : 'create', entityId: Number(row.id), payload: response, origin: metadata.clientId }).catch(() => undefined)
        return response
      } catch (error) {
        if (!committed) {
          await client.query('ROLLBACK').catch(() => undefined)
          for (const artifact of state.createdArtifacts) await rm(artifact, { force: true }).catch(() => undefined)
          for (const destination of state.createdDestinations) await rm(destination, { force: true }).catch(() => undefined)
          if (state.finalPath && (state.replacedDestination || state.rollbackPath)) {
            if (state.replacedDestination) await rm(state.finalPath, { force: true }).catch(() => undefined)
            if (state.rollbackPath) await rename(state.rollbackPath, state.finalPath).catch(() => undefined)
          }
        }
        throw error
      } finally {
        for (const directory of state.stagingDirectories) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
        client.release()
      }
    },
  }
}


