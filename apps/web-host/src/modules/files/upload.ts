import multipart from '@fastify/multipart'
import { CoreError } from '@gugu/core'
import { imageSizeFromFile } from 'image-size/fromFile'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, copyFile, link, lstat, mkdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { WriteRequestMetadata } from '../../app.js'
import type { PoolClient, Pool, QueryResultRow } from 'pg'
import { writeRequestMetadata } from '../../http/request.js'
import { runBestEffort } from '../../shared/best-effort.js'
import { isPathWithin } from '../../shared/path-safety.js'
import { withPostgresTransaction } from '../../adapters/database/postgres-transaction.js'
import { isOwnedFilePath, normalizeFileOwnerId } from './store.js'
import { sandboxTarget } from '../workspaces/roots.js'

export interface FileUploadInput {
  space: string
  projectId: number | null
  workspaceDirectoryId: number | null
  stageName: string
  mindMapId: number | null
  onConflict: 'keep_both' | 'overwrite'
  overwriteFilePath: string | null
}

export interface StagedUpload {
  input: FileUploadInput
  originalName: string
  mimeType: string | null
  path: string
  sizeBytes: number
  sha256: string
  imgWidth: number | null
  imgHeight: number | null
}

export interface FileUploadOperations {
  validateUploadTarget(ownerId: string, input: FileUploadInput): Promise<void>
  store(ownerId: string, upload: StagedUpload, metadata: WriteRequestMetadata,
    operation?: { receipt: FileUploadReceipt; signal?: AbortSignal; authorize(client: Pick<PoolClient, 'query'>): Promise<void> }): Promise<unknown>
}

export interface FileUploadReceipt { operationId: string; fingerprint: string; method?: 'agent.web.download' | 'agent.file.create' | 'agent.file.save_uploaded_file' }

const IMAGE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'image/bmp', 'image/heic', 'image/heif',
])

export interface FileUploadRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileUploadOperations
  cleanupTemp?: (directory: string) => Promise<void>
}

function integer(value: string | undefined, field: string): number | null {
  if (value === undefined || value === '') return null
  if (!/^[+-]?\d+$/.test(value)) throw new CoreError('invalid_request', `${field} 无效`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new CoreError('invalid_request', `${field} 无效`)
  return parsed
}

function filePath(value: string | undefined): string | null {
  if (value === undefined || value === '') return null
  if (value.length > 1000 || value.startsWith('/') || value.includes('\\') || value.includes('\0'))
    throw new CoreError('invalid_request', '覆盖文件路径无效')
  const segments = value.split('/')
  if (segments.length < 2 || segments.some((segment) => !segment || segment === '.' || segment === '..'))
    throw new CoreError('invalid_request', '覆盖文件路径无效')
  return value
}

function inputFrom(fields: Map<string, string>): FileUploadInput {
  const onConflict = fields.get('on_conflict') ?? 'keep_both'
  if (onConflict !== 'keep_both' && onConflict !== 'overwrite')
    throw new CoreError('invalid_request', '冲突处理方式无效')
  const overwriteFilePath = filePath(fields.get('overwrite_file_path'))
  if (onConflict === 'overwrite' && overwriteFilePath === null)
    throw new CoreError('invalid_request', '覆盖上传缺少目标文件')
  if (onConflict === 'keep_both' && overwriteFilePath !== null)
    throw new CoreError('invalid_request', '保留同名文件时不能指定覆盖目标')
  const space = fields.get('space') ?? 'personal'
  if (!['personal', 'project', 'workspace', 'mind', 'asset'].includes(space))
    throw new CoreError('invalid_request', '文件空间无效')
  const stageName = fields.get('stage_name') ?? ''
  if (stageName.length > 100) throw new CoreError('invalid_request', '阶段名称过长')
  return {
    space,
    projectId: integer(fields.get('project_id'), 'project_id'),
    workspaceDirectoryId: integer(fields.get('workspace_directory_id'), 'workspace_directory_id'),
    stageName,
    mindMapId: integer(fields.get('mind_map_id'), 'mind_map_id'),
    onConflict,
    overwriteFilePath,
  }
}

function uploadError(): Error {
  const error = new Error('文件超过上传大小限制') as Error & { statusCode: number }
  error.statusCode = 413
  return error
}

export async function stageFile(
  file: NodeJS.ReadableStream,
  directory: string,
  mimeType: string | null,
  signal?: AbortSignal,
): Promise<{ path: string; sizeBytes: number; sha256: string; imgWidth: number | null; imgHeight: number | null }> {
  const filePath = path.join(directory, 'upload')
  let sizeBytes = 0
  const hash = createHash('sha256')
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(file, measure, createWriteStream(filePath, { flags: 'wx', mode: 0o600 }), { signal })
  let imgWidth: number | null = null
  let imgHeight: number | null = null
  const normalizedMimeType = mimeType?.toLowerCase()
  if (normalizedMimeType && IMAGE_MIMES.has(normalizedMimeType)) {
    try {
      const dimensions = await imageSizeFromFile(filePath)
      imgWidth = dimensions.width
      imgHeight = dimensions.height
    } catch {
      // 像 Python 上传路径一样，损坏或不受支持的图片不阻止文件上传。
    }
  }
  return { path: filePath, sizeBytes, sha256: hash.digest('hex'), imgWidth, imgHeight }
}

export function registerFileUploadRoutes(app: FastifyInstance, options: FileUploadRouteOptions): void {
  app.post('/api/v1/files', { preHandler: options.requireUser }, async (request, reply) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gugu-upload-'))
    try {
      const fields = new Map<string, string>()
      let staged: StagedUpload | null = null
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          if (staged) throw new CoreError('invalid_request', '上传文件必须是表单最后一项')
          if (fields.has(part.fieldname)) throw new CoreError('invalid_request', '上传表单字段重复')
          if (typeof part.value !== 'string') throw new CoreError('invalid_request', '上传表单字段无效')
          fields.set(part.fieldname, part.value)
          continue
        }
        if (staged) throw new CoreError('invalid_request', '每次只能上传一个文件')
        const input = inputFrom(fields)
        const ownerId = options.ownerIdFromRequest(request)
        await options.operations.validateUploadTarget(ownerId, input)
        const mimeType = part.mimetype || null
        const file = await stageFile(part.file, directory, mimeType)
        if (part.file.truncated) throw uploadError()
        staged = {
          input,
          originalName: path.basename(part.filename || 'file').slice(0, 512),
          mimeType,
          ...file,
        }
      }
      if (!staged) throw new CoreError('invalid_request', '缺少上传文件')
      const result = await options.operations.store(options.ownerIdFromRequest(request), staged, writeRequestMetadata(request, { limitHeaders: true }))
      return reply.code(201).send(result)
    } finally {
      await runBestEffort('上传临时目录清理', () => options.cleanupTemp?.(directory) ?? rm(directory, { recursive: true, force: true }), () => {
        console.error('上传临时目录清理失败，可能存在残留')
      })
    }
  })
}

export function installFileUploadSupport(app: FastifyInstance): void {
  app.register(multipart, {
    limits: { files: 1, fields: 10, parts: 11, fieldSize: 4096, fileSize: Number.MAX_SAFE_INTEGER },
  })
}


const UNDO_CONTENT_MAX = 64 * 1024 * 1024

interface Target {
  project: { id: number; name: string; color: string | null; year: string; month: string } | null
  workspaceName: string | null
  mindMap: { id: number; title: string } | null
}

interface FileRow extends QueryResultRow {
  user_id: string
  display_name: string
  ext: string
  space: string
  project_id: number | string | null
  workspace_directory_id: number | string | null
  stage_name: string
  mind_map_id: number | string | null
  path: string
  size: string
  size_bytes: number | string
  mime_type: string | null
  img_width: number | string | null
  img_height: number | string | null
  version: number | string
  created_at: Date | string
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
    `SELECT id,name,color,COALESCE(to_char(NULLIF(start_date::text,'')::date,'YYYY'),to_char(created_at,'YYYY')) AS year,
       COALESCE(to_char(NULLIF(start_date::text,'')::date,'MM'),to_char(created_at,'MM')) AS month
       FROM projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [projectId, userId],
  )
  const row = result.rows[0]
  if (!row) throw new CoreError('not_found', '项目不存在')
  return { id: Number(row.id), name: row.name, color: row.color, year: row.year, month: row.month }
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
  return { project, workspaceName, mindMap }
}

function keyFor(userId: string, input: FileUploadInput, target: Target, displayName: string, ext: string): string {
  const filename = `${safeSegment(displayName)}${ext ? `.${ext}` : ''}`
  if (input.space === 'project')
    return [userId, '项目文件', target.project!.year, target.project!.month,
      `${safeSegment(target.project!.name)} #${target.project!.id}`, filename].filter(Boolean).join('/')
  if (input.space === 'workspace')
    return [userId, 'workspace', safeSegment(target.workspaceName!), filename].filter(Boolean).join('/')
  if (input.space === 'mind') return [userId, '思维', `${safeSegment(target.mindMap!.title)} #${target.mindMap!.id}`, filename].join('/')
  if (input.space === 'asset') return [userId, '素材板', filename].join('/')
  return [userId, '个人文件', filename].filter(Boolean).join('/')
}

function fileResponse(row: FileRow, target: Target) {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : `${row.created_at.replace(/Z?$/, 'Z')}`
  return {
    filePath: row.path, displayName: row.display_name, ext: row.ext, space: row.space,
    workspaceDirectoryId: row.workspace_directory_id === null ? null : Number(row.workspace_directory_id),
    projectId: row.project_id === null ? null : Number(row.project_id),
    projectName: target.project?.name ?? null,
    projectColor: target.project?.color?.match(/#[0-9a-fA-F]{3,6}/)?.[0] ?? target.project?.color ?? null,
    stageName: row.stage_name,
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
  const ref = `file:${before?.path ?? row.path}`
  const snapshot = (file: FileRow) => ({
    display_name: file.display_name, ext: file.ext, space: file.space,
    project_id: file.project_id === null ? null : Number(file.project_id),
    workspace_directory_id: file.workspace_directory_id === null ? null : Number(file.workspace_directory_id),
    stage_name: file.stage_name, mind_map_id: file.mind_map_id === null ? null : Number(file.mind_map_id),
    path: file.path, version: Number(file.version), size: file.size,
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
      action, JSON.stringify([{ kind: 'file', path: before?.path ?? row.path }]),
      JSON.stringify({ items: before ? { [ref]: snapshot(before) } : {} }),
      JSON.stringify({ items: { [ref]: snapshot(row) } }),
      JSON.stringify({ [ref]: { version: before ? Number(before.version) : 0 } }), JSON.stringify(artifacts)],
  )
}

interface UploadStoreOptions {
  storageRoot: string
  removeCommittedBackup?: (backupPath: string) => Promise<void>
  restoreBackup?: typeof rename
  afterStore?: () => Promise<void>
  publishChanged(event: {
    ownerId: string; operation: 'create' | 'update'; entityId: string
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
  downloadLink?: { key: string; stagedPath: string }
}

function validateOverwriteTarget(before: FileRow, upload: StagedUpload, ownerId: string, target: Target, displayName: string, ext: string): void {
  const { input } = upload
  if (!isOwnedFilePath(ownerId, before.path)) throw new CoreError('not_found', '文件不存在')
  const imported = before.path.startsWith(`${ownerId.replaceAll('-', '')}/.data-portability/imported/`)
  if (before.space !== input.space
    || (before.project_id === null ? null : Number(before.project_id)) !== input.projectId
    || (!imported && before.path !== keyFor(ownerId, input, target, displayName, ext))
    || (before.workspace_directory_id === null ? null : Number(before.workspace_directory_id)) !== input.workspaceDirectoryId
    || (before.mind_map_id === null ? null : Number(before.mind_map_id)) !== input.mindMapId
    || before.display_name !== displayName || before.ext.toLowerCase() !== ext)
    throw new CoreError('invalid_request', '覆盖目标与上传文件不匹配')
}

async function loadOverwriteTarget(client: PoolClient, userId: string, upload: StagedUpload): Promise<FileRow | null> {
  if (upload.input.onConflict !== 'overwrite') return null
  const storageKey = upload.input.overwriteFilePath
  if (!storageKey || !isOwnedFilePath(userId, storageKey)) throw new CoreError('not_found', '要覆盖的文件不存在')
  const result = await client.query<FileRow>(
    'SELECT * FROM files WHERE path=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE',
    [storageKey, userId],
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
  if (!isOwnedFilePath(userId, before.path)) throw new CoreError('not_found', '文件不存在')
  const destination = (await storagePath(options.storageRoot, before.path)).target
  state.finalPath = destination
  const stagedPath = await stageForStorage(upload.path, destination, state)
  const undoContext = metadata.undoContextId && upload.sizeBytes <= UNDO_CONTENT_MAX
    ? metadata.undoContextId
    : null
  let artifactRefs: Record<string, unknown> = {}
  let undoId: string | undefined
  if (undoContext !== null) {
    undoId = `op-${randomUUID().replaceAll('-', '')}`
    const fileKey = createHash('sha256').update(before.path).digest('hex').slice(0, 24)
    const prefix = `${userId}/.undo/${undoId}/file-${fileKey}`
    const beforeArtifact = await storagePath(options.storageRoot, `${prefix}/before`)
    const afterArtifact = await storagePath(options.storageRoot, `${prefix}/after`)
    await mkdir(path.dirname(beforeArtifact.target), { recursive: true, mode: 0o700 })
    state.createdArtifacts.push(beforeArtifact.target, afterArtifact.target)
    await copyFile(destination, beforeArtifact.target)
    await copyFile(stagedPath, afterArtifact.target)
    artifactRefs = { [`file:${before.path}`]: { before_key: `${prefix}/before`, after_key: `${prefix}/after` } }
  }
  const updated = await client.query<FileRow>(
    `UPDATE files SET size=$3,size_bytes=$4,mime_type=$5,img_width=$6,img_height=$7,
       version=version+1,updated_at=CURRENT_TIMESTAMP
     WHERE path=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING *`,
    [before.path, userId, formatFileSize(upload.sizeBytes), upload.sizeBytes, upload.mimeType,
      upload.imgWidth, upload.imgHeight],
  )
  const row = updated.rows[0]
  if (!row) throw new CoreError('not_found', '要覆盖的文件不存在')
  state.rollbackPath = `${stagedPath}.old`
  await rename(destination, state.rollbackPath)
  await rename(stagedPath, destination)
  state.replacedDestination = true
  if (undoContext) await insertUndo(client, userId, undoContext, 'overwrite', row, before, artifactRefs, undoId)
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
    const collision = await client.query('SELECT 1 FROM files WHERE user_id=$1 AND path=$2 AND deleted_at IS NULL', [userId, key])
    if (!exists && !collision.rowCount) return { key, name }
    suffix++
  }
}

async function storeNewFile(
  client: PoolClient, options: UploadStoreOptions, state: UploadStoreState,
  userId: string, upload: StagedUpload, metadata: { undoContextId: string | null },
  target: Target, displayName: string, ext: string, source: 'file_upload' | 'onboarding_seed' | 'web_download' = 'file_upload',
): Promise<FileRow> {
  const baseKey = keyFor(userId, upload.input, target, displayName, ext)
  const { key, name } = await availableStorageKey(client, options, userId, baseKey, displayName, ext)
  const destination = (await storagePath(options.storageRoot, key)).target
  const stagedPath = await stageForStorage(upload.path, destination, state)
  const inserted = await client.query<FileRow>(
    `INSERT INTO files (user_id,display_name,ext,space,workspace_directory_id,project_id,
       stage_name,mind_map_id,path,storage_backend,version,size,size_bytes,mime_type,
       img_width,img_height,created_at,updated_at,deleted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'local',1,$10,$11,$12,$13,$14,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL)
     RETURNING *`,
    [userId, name, ext, upload.input.space, upload.input.workspaceDirectoryId,
      upload.input.space === 'project' ? upload.input.projectId : null,
      upload.input.stageName, upload.input.space === 'mind' ? upload.input.mindMapId : null,
      key, formatFileSize(upload.sizeBytes), upload.sizeBytes, upload.mimeType,
      upload.imgWidth, upload.imgHeight],
  )
  const row = inserted.rows[0]
  if (!row) throw new CoreError('storage_error', '文件记录未能创建')
  await link(stagedPath, destination)
  state.finalPath = destination
  state.createdDestinations.push(destination)
  state.replacedDestination = true
  // 下载保留一个硬链接，用于核对 COMMIT 响应丢失后的文件归属。
  if (source === 'web_download') state.downloadLink = { key, stagedPath }
  else await rm(stagedPath)
  if (metadata.undoContextId && upload.sizeBytes <= UNDO_CONTENT_MAX)
    await insertUndo(client, userId, metadata.undoContextId, 'create', row, null, {})
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
 * Writes onboarding files through the same Local path, collision and metadata rules
 * as regular uploads, while letting the onboarding adapter keep all rows in its transaction.
 */
export function createPostgresRegistrationSeedFileWriter(storageRoot: string) {
  return async function writeSeedFiles(
    client: PoolClient,
    userId: string,
    projectId: number,
    files: readonly RegistrationSeedLocalFile[],
  ): Promise<{ filePaths: string[]; rollback(): Promise<void>; finalize(): Promise<void> }> {
    const state: UploadStoreState = {
      finalPath: null, createdDestinations: [], rollbackPath: null, replacedDestination: false,
      stagingDirectories: [], createdArtifacts: [],
    }
    const tempDirectory = await mkdtemp(path.join(tmpdir(), 'gugu-onboarding-seed-'))
    const options: UploadStoreOptions = {
      storageRoot,
      async publishChanged() {},
    }
    try {
      const filePaths: string[] = []
      for (const [index, file] of files.entries()) {
        const tempPath = path.join(tempDirectory, `seed-${index}`)
        await writeFile(tempPath, file.data, { mode: 0o600, flag: 'wx' })
        const input: FileUploadInput = {
          space: file.space, projectId: file.space === 'project' ? projectId : null,
          workspaceDirectoryId: null, stageName: '', mindMapId: null,
          onConflict: 'keep_both', overwriteFilePath: null,
        }
        const upload: StagedUpload = {
          input, originalName: `${file.displayName}.${file.ext}`, mimeType: file.mimeType,
          path: tempPath, sizeBytes: file.data.byteLength, sha256: '', imgWidth: null, imgHeight: null,
        }
        const target = await resolveTarget(client, userId, input)
        const { displayName, ext } = parseName(upload.originalName)
        const row = await storeNewFile(client, options, state, userId, upload, { undoContextId: null }, target,
          displayName, ext, 'onboarding_seed')
        filePaths.push(row.path)
      }
      return {
        filePaths,
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

const downloadMethod = 'agent.web.download'

async function readDownloadReceipt(client: Pick<Pool, 'query'>, owner: string, receipt: FileUploadReceipt): Promise<unknown | null> {
  const result = await client.query<{ method: string; fingerprint: string; result_json: string }>(
    'SELECT method,fingerprint,result_json FROM core_operation_receipts WHERE owner_id=$1 AND operation_id=$2',
    [owner, receipt.operationId],
  )
  const row = result.rows[0]
  if (!row) return null
  if (row.method !== (receipt.method ?? downloadMethod) || row.fingerprint !== receipt.fingerprint)
    throw new CoreError('conflict', '操作标识已用于不同内容')
  return JSON.parse(row.result_json)
}

async function lockDownload(client: PoolClient, owner: string, receipt: FileUploadReceipt) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${owner}:${receipt.operationId}`])
}

async function lockOwnerUploads(client: PoolClient, owner: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('file-upload:' || $1, 0))", [owner])
}

async function recoverDownloadLink(pool: Pool, storageRoot: string, owner: string, receipt: FileUploadReceipt,
  pending: NonNullable<UploadStoreState['downloadLink']>,
): Promise<void> {
  await withPostgresTransaction(pool, async client => {
    await lockDownload(client, owner, receipt)
    await lockOwnerUploads(client, owner)
    const registered = await client.query('SELECT 1 FROM files WHERE user_id=$1 AND path=$2 LIMIT 1', [owner, pending.key])
    if (registered.rows.length) return
    const { target } = await storagePath(storageRoot, pending.key)
    const destination = await lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (!destination) return
    const staged = await lstat(pending.stagedPath, { bigint: true })
    if (destination.isFile() && staged.isFile() && destination.dev === staged.dev && destination.ino === staged.ino)
      await unlink(target)
  })
}

export function createPostgresFileUploadOperations(
  pool: Pool,
  options: UploadStoreOptions,
): FileUploadOperations & { readDownloadReceipt(ownerId: string, receipt: FileUploadReceipt): Promise<unknown | null> } {
  return {
    readDownloadReceipt: (ownerId, receipt) => readDownloadReceipt(pool, normalizeFileOwnerId(ownerId), receipt),
    async validateUploadTarget(rawOwnerId, input) {
      const userId = normalizeFileOwnerId(rawOwnerId)
      const client = await pool.connect()
      try {
        await resolveTarget(client, userId, input)
      } finally { client.release() }
    },

    async store(rawOwnerId, upload: StagedUpload, metadata, operation) {
      operation?.signal?.throwIfAborted()
      const userId = normalizeFileOwnerId(rawOwnerId)
      const { displayName, ext } = parseName(upload.originalName)
      const client = await pool.connect()
      const state: UploadStoreState = {
        finalPath: null, createdDestinations: [], rollbackPath: null, replacedDestination: false,
        stagingDirectories: [], createdArtifacts: [],
      }
      let committed = false
      let commitAttempted = false
      let preserveStage = false
      let released = false
      let discardConnection = false
      try {
        await client.query('BEGIN')
        if (operation) {
          const { receipt } = operation
          await lockDownload(client, userId, receipt)
          operation.signal?.throwIfAborted()
          const previous = await readDownloadReceipt(client, userId, receipt)
          if (previous !== null) {
            await client.query('COMMIT')
            committed = true
            return { file: previous, replayed: true }
          }
        }
        await lockOwnerUploads(client, userId)
        await operation?.authorize(client)
        const target = await resolveTarget(client, userId, upload.input)
        const before = await loadOverwriteTarget(client, userId, upload)
        if (before) validateOverwriteTarget(before, upload, userId, target, displayName, ext)
        const row = before
          ? await storeOverwrite(client, options, state, userId, upload, metadata, target, before)
          : await storeNewFile(client, options, state, userId, upload, metadata, target, displayName, ext,
            operation && (operation.receipt.method ?? downloadMethod) === downloadMethod ? 'web_download' : 'file_upload')
        await options.afterStore?.()
        const file = fileResponse(row, target)
        const response = operation && (operation.receipt.method ?? downloadMethod) === downloadMethod
          ? { ...file, logicalPath: sandboxTarget(row.path) }
          : operation?.receipt.method === 'agent.file.save_uploaded_file'
            ? { ...file, logicalPath: `/${[
              ...(file.space === 'project' ? ['project', target.project!.name]
                : file.space === 'workspace' ? ['workspace', target.workspaceName!] : ['personal']),
              `${file.displayName}${file.ext ? `.${file.ext}` : ''}`,
            ].map(part => part.replace(/[\\/]/gu, '_').trim()).join('/')}` }
            : file
        if (operation) {
          const { receipt } = operation
          await operation.authorize(client)
          operation.signal?.throwIfAborted()
          const receiptResult = response
          await client.query(`INSERT INTO core_operation_receipts(owner_id,operation_id,method,fingerprint,result_json,created_at)
            VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)`, [userId, receipt.operationId, receipt.method ?? downloadMethod, receipt.fingerprint, JSON.stringify(receiptResult)])
          operation.signal?.throwIfAborted()
        }
        commitAttempted = true
        await client.query('COMMIT')
        committed = true
        if (state.rollbackPath) await Promise.resolve().then(() => options.removeCommittedBackup?.(state.rollbackPath!) ?? rm(state.rollbackPath!, { force: true })).catch(() => {
          console.error('文件上传备份清理失败，将尝试清理暂存目录')
        })
        await options.publishChanged({ ownerId: userId, operation: before ? 'update' : 'create', entityId: row.path, payload: response, origin: metadata.clientId }).catch(() => undefined)
        return operation ? { file: response, replayed: false } : response
      } catch (error) {
        if (!committed) {
          await client.query('ROLLBACK').catch(() => { discardConnection = true })
          if (!commitAttempted) {
            for (const artifact of state.createdArtifacts) await rm(artifact, { force: true }).catch(() => undefined)
            for (const destination of state.createdDestinations) await rm(destination, { force: true }).catch(() => undefined)
            if (state.finalPath && (state.replacedDestination || state.rollbackPath)) {
              if (state.replacedDestination) await rm(state.finalPath, { force: true }).catch(() => undefined)
              if (state.rollbackPath) await Promise.resolve().then(() => (options.restoreBackup ?? rename)(state.rollbackPath!, state.finalPath!)).catch(() => {
                preserveStage = true
                console.error('文件上传回滚失败，保留备份供核查')
              })
            }
          } else if (operation && state.downloadLink) {
            // 先归还旧连接，避免重查等待该连接的事务锁或池容量。
            client.release(true)
            released = true
            try { await recoverDownloadLink(pool, options.storageRoot, userId, operation.receipt, state.downloadLink) }
            catch {
              preserveStage = true
              console.error('下载提交结果暂时无法核对，保留文件供核查')
            }
          } else {
            preserveStage = true
            console.error('文件上传提交结果未知，保留文件供核查')
          }
        }
        throw error
      } finally {
        if (!preserveStage) for (const directory of state.stagingDirectories) await rm(directory, { recursive: true, force: true }).catch(() => console.error('文件上传暂存目录清理失败，可能存在残留'))
        if (!released) client.release(discardConnection)
      }
    },
  }
}

/** 使用文件页面一致的单位显示字节数。 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}
