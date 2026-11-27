import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { WriteRequestMetadata } from '../../app.js'
import { writeRequestMetadata } from '../../http/request.js'
import { isOwnedFilePath, normalizeFileOwnerId } from './store.js'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { isPathWithin } from '../../shared/path-safety.js'
import { runBestEffort } from '../../shared/best-effort.js'
import { formatFileSize } from './upload.js'
import { lockFileSyncPath, recordCanonicalFileChange } from './storage/sync.js'
import { imageSize } from 'image-size'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { planFileThumbnail, openAuthorizedRelativeFile } from '@gugu/core/files/read'
import type { FileContentSource, FileReadOperations } from './browse.js'
import { XlsxPreviewError, createXlsxPreviewReader, type XlsxPreviewArchive, type XlsxPreviewArchiveEntry } from '@gugu/core/files/xlsx-preview'
import { openLocalFile, UnsafeLocalPathError } from '@gugu/fs/node'
import JSZip from 'jszip'

export interface FileContentOperations {
  update(ownerId: string, storageKey: string, content: string, version: number, metadata: WriteRequestMetadata): Promise<unknown>
}

export interface FileContentRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileContentOperations
}

export function registerFileContentRoutes(app: FastifyInstance, options: FileContentRouteOptions): void {
  app.put<{ Body: { content?: unknown; version?: unknown } }>(
    '/api/v1/files/by-path/content', { preHandler: options.requireUser, bodyLimit: 8 * 1024 * 1024 }, async (request) => {
      const { content, version } = request.body ?? {}
      if (typeof content !== 'string' || !Number.isSafeInteger(version) || Number(version) < 1)
        throw new CoreError('invalid_request', '文件内容或版本无效')
      return options.operations.update(
        options.ownerIdFromRequest(request), fileStorageKey(request), content, Number(version), writeRequestMetadata(request, { limitHeaders: true }),
      )
    },
  )
}

function fileStorageKey(request: FastifyRequest): string {
  const value = (request.query as Record<string, unknown>).path
  if (typeof value !== 'string' || !value || value.length > 4096 || value.startsWith('/')
    || value.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')))
    throw new CoreError('invalid_request', '文件路径无效')
  return value
}

const FILE_LIBRARY = 'file_library'

const TEXT_EXTS = new Set([
  'md', 'markdown', 'txt', 'text', 'json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'html', 'htm', 'css',
  'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'rb', 'php', 'sh', 'bash',
  'sql', 'ini', 'toml', 'conf', 'log', 'vue', 'svg', 'env', 'm3u', 'm3u8',
])

interface FileRow extends QueryResultRow {
  user_id: string; display_name: string; ext: string; space: string
  project_id: number | string | null
  workspace_directory_id: number | string | null; stage_name: string; mind_map_id: number | string | null
  path: string; version: number | string; size: string; size_bytes: number | string
  mime_type: string | null; img_width: number | string | null; img_height: number | string | null
  created_at: Date | string; project_name?: string | null; project_color?: string | null
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
    display_name: row.display_name, ext: row.ext, space: row.space,
    project_id: row.project_id === null ? null : Number(row.project_id),
    workspace_directory_id: row.workspace_directory_id === null ? null : Number(row.workspace_directory_id),
    stage_name: row.stage_name, mind_map_id: row.mind_map_id === null ? null : Number(row.mind_map_id),
    path: row.path, version: Number(row.version), size: row.size, size_bytes: Number(row.size_bytes),
    mime_type: row.mime_type, img_width: row.img_width === null ? null : Number(row.img_width),
    img_height: row.img_height === null ? null : Number(row.img_height), deleted_at: null,
  }
}

async function recordUndo(
  client: PoolClient, ownerId: string, contextId: string | null, before: FileRow, after: FileRow,
  beforeKey: string, afterKey: string, id: string,
): Promise<void> {
  const context = contextId?.trim().slice(0, 128)
  if (!context) return
  const ref = `file:${before.path}`
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
      JSON.stringify([{ kind: 'file', path: before.path }]),
      JSON.stringify({ items: { [ref]: snapshot(before) } }), JSON.stringify({ items: { [ref]: snapshot(after) } }),
      JSON.stringify({ [ref]: { version: Number(before.version) } }),
      JSON.stringify({ [ref]: { before_key: beforeKey, after_key: afterKey } })],
  )
}

function response(row: FileRow) {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : `${row.created_at.replace(/Z?$/, 'Z')}`
  return {
    filePath: row.path, displayName: row.display_name, ext: row.ext, space: row.space,
    workspaceDirectoryId: row.workspace_directory_id === null ? null : Number(row.workspace_directory_id),
    projectId: row.project_id === null ? null : Number(row.project_id), projectName: row.project_name ?? null,
    projectColor: row.project_color?.match(/#[0-9a-fA-F]{3,6}/)?.[0] ?? row.project_color ?? null,
    stageName: row.stage_name, mindMapId: row.mind_map_id === null ? null : Number(row.mind_map_id),
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
    removeCommittedBackup?: (backupPath: string) => Promise<void>
    restoreBackup?: typeof rename
    recordFileChange?: typeof recordCanonicalFileChange
    publishChanged(event: { ownerId: string; entityId: string; payload: Record<string, unknown>; origin: string | null }): Promise<void>
  },
): FileContentOperations {
  return {
    async update(rawOwnerId, storageKey, content, version, metadata: WriteRequestMetadata) {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      const data = Buffer.from(content, 'utf8')
      if (data.byteLength > 1024 * 1024) throw Object.assign(new Error('内容过大（上限 1MB）'), { statusCode: 400 })
      const client = await pool.connect()
      let committed = false
      let commitAttempted = false
      let preserveStage = false
      let destination: string | null = null
      let rollbackPath: string | null = null
      let stagedPath: string | null = null
      const artifactPaths: string[] = []
      try {
        await client.query('BEGIN')
        const found = await client.query<FileRow>(
          'SELECT * FROM files WHERE path=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE', [storageKey, ownerId],
        )
        const before = found.rows[0]
        if (!before) throw new CoreError('not_found', '文件不存在')
        if (!isOwnedFilePath(ownerId, before.path)) throw new CoreError('not_found', '文件不存在')
        await lockFileSyncPath(client, ownerId, before.path)
        const mime = (before.mime_type ?? '').toLowerCase()
        if (!TEXT_EXTS.has(before.ext.toLowerCase()) && !mime.startsWith('text/')
          && !['application/json', 'application/xml', 'application/javascript', 'application/typescript', 'application/sql', 'application/x-sh'].includes(mime)
          && !mime.endsWith('+json') && !mime.endsWith('+xml'))
          throw Object.assign(new Error('仅文本类文件可改内容'), { statusCode: 400 })
        if (Number(before.version) !== version) throw new CoreError('conflict', '文件已被其他端修改，请刷新后重试')
        destination = await storagePath(options.storageRoot, before.path)
        const beforeData = await readFile(destination).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') throw new CoreError('not_found', '文件不存在于存储')
          throw error
        })
        const directory = await mkdtemp(path.join(path.dirname(destination), '.content-stage-'))
        stagedPath = path.join(directory, 'content')
        await writeFile(stagedPath, data, { flag: 'wx', mode: 0o600 })
        const next = await client.query<FileRow>(
          `UPDATE files SET version=version+1,size=$4,size_bytes=$5,updated_at=CURRENT_TIMESTAMP
           WHERE path=$1 AND user_id=$2 AND deleted_at IS NULL AND version=$3 RETURNING *`,
          [storageKey, ownerId, version, formatFileSize(data.byteLength), data.byteLength],
        )
        const after = next.rows[0]
        if (!after) throw new CoreError('conflict', '文件已被其他端修改，请刷新后重试')
        const undoContext = metadata.undoContextId?.trim().slice(0, 128) || null
        let beforeKey = ''
        let afterKey = ''
        if (undoContext) {
          const operationId = `op-${randomUUID().replaceAll('-', '')}`
          const fileKey = createHash('sha256').update(String(before.path)).digest('hex').slice(0, 24)
          const prefix = `${ownerId}/.undo/${operationId}/file-${fileKey}`
          beforeKey = `${prefix}/before`
          afterKey = `${prefix}/after`
          const beforePath = await storagePath(options.storageRoot, beforeKey)
          const afterPath = await storagePath(options.storageRoot, afterKey)
          await mkdir(path.dirname(beforePath), { recursive: true, mode: 0o700 })
          await copyFile(destination, beforePath)
          artifactPaths.push(beforePath, afterPath)
          await copyFile(stagedPath, afterPath)
          await recordUndo(client, ownerId, undoContext, before, after, beforeKey, afterKey, operationId)
        }
        rollbackPath = `${stagedPath}.old`
        await rename(destination, rollbackPath)
        await rename(stagedPath, destination)
        await (options.recordFileChange ?? recordCanonicalFileChange)(client, {
          ownerId,
          storageRoot: options.storageRoot,
          storageKey: before.path,
          observedFingerprint: createHash('sha256').update(data).digest('hex'),
          enabled: options.fileSyncEnabled ?? true,
        })
        commitAttempted = true
        await client.query('COMMIT')
        committed = true
        await runBestEffort('文件正文备份清理', () => options.removeCommittedBackup?.(rollbackPath!) ?? rm(rollbackPath!, { force: true }), () => {
          console.error('文件正文备份清理失败，将尝试清理暂存目录')
        })
        const full = await client.query<FileRow>(
          `SELECT file.*,project.name AS project_name,project.color AS project_color
           FROM files file LEFT JOIN projects project ON project.id=file.project_id AND project.user_id=file.user_id
           WHERE file.path=$1 AND file.user_id=$2`, [storageKey, ownerId],
        )
        const result = full.rows[0] ? response(full.rows[0]) : response(after)
        await options.publishChanged({ ownerId, entityId: storageKey, payload: result, origin: metadata.clientId }).catch(() => undefined)
        return result
      } catch (error) {
        if (!committed) {
          await client.query('ROLLBACK').catch(() => undefined)
          if (!commitAttempted && destination && rollbackPath) await Promise.resolve().then(() => (options.restoreBackup ?? rename)(rollbackPath!, destination!)).catch(() => {
            preserveStage = true
            console.error('文件正文回滚失败，保留备份供核查')
          })
          if (!commitAttempted) for (const artifact of artifactPaths) await rm(artifact, { force: true }).catch(() => undefined)
          if (commitAttempted) console.error('文件正文提交结果未知，保留备份供核查')
        }
        throw error
      } finally {
        if (stagedPath && !preserveStage && (!commitAttempted || committed)) await rm(path.dirname(stagedPath), { recursive: true, force: true }).catch(() => {
          console.error('文件正文暂存目录清理失败，可能存在残留')
        })
        client.release()
      }
    },
  }
}

export interface FileThumbnailOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileReadOperations
}

type ThumbnailFile = { mimeType?: unknown; version?: unknown }

type RenderedThumbnail = { bytes: Buffer; mimeType: string }

type ThumbnailMetadata = { mimeType: string | null; version: number }

const THUMBNAIL_CACHE_MAX_BYTES = 32 * 1024 * 1024

const THUMBNAIL_CACHE_MAX_ENTRIES = 128

const thumbnailCache = new Map<string, RenderedThumbnail>()

let thumbnailCacheBytes = 0

function fileMetadata(file: unknown): ThumbnailMetadata {
  if (!file || typeof file !== 'object' || Array.isArray(file)) return { mimeType: null, version: 1 }
  const value = file as ThumbnailFile
  return {
    mimeType: typeof value.mimeType === 'string' ? value.mimeType : null,
    version: typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version > 0
      ? value.version
      : 1,
  }
}

function detectedFormat(raw: Buffer): string | null {
  try {
    const type = imageSize(raw).type
    return type === 'jpg' ? 'JPEG' : typeof type === 'string' ? type.toUpperCase() : null
  } catch { return null }
}

async function resizeThumbnail(raw: Buffer, maxDimension: number, quality: number): Promise<RenderedThumbnail> {
  const image = await loadImage(raw)
  const scale = Math.min(1, maxDimension / Math.max(image.width, image.height))
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0, width, height)
  try {
    return { bytes: canvas.toBuffer('image/webp', quality), mimeType: 'image/webp' }
  } catch {
    const fallbackCanvas = createCanvas(width, height)
    fallbackCanvas.getContext('2d').drawImage(image, 0, 0, width, height)
    try { return { bytes: fallbackCanvas.toBuffer('image/jpeg', 80), mimeType: 'image/jpeg' } }
    catch { return { bytes: raw, mimeType: 'application/octet-stream' } }
  }
}

function cacheThumbnail(key: string, result: RenderedThumbnail): void {
  if (result.bytes.byteLength > THUMBNAIL_CACHE_MAX_BYTES) return
  while (thumbnailCache.size >= THUMBNAIL_CACHE_MAX_ENTRIES
    || thumbnailCacheBytes + result.bytes.byteLength > THUMBNAIL_CACHE_MAX_BYTES) {
    const oldest = thumbnailCache.keys().next().value
    if (oldest === undefined) return
    const removed = thumbnailCache.get(oldest)
    if (removed) thumbnailCacheBytes -= removed.bytes.byteLength
    thumbnailCache.delete(oldest)
  }
  thumbnailCache.set(key, result)
  thumbnailCacheBytes += result.bytes.byteLength
}

/** 按缓存键中的属主清理该账号的所有缩略图。 */
export function deleteOwnerThumbnailCache(ownerId: string): void {
  for (const [key, value] of thumbnailCache) {
    let identity: unknown
    try { identity = JSON.parse(key) } catch { continue }
    if (!Array.isArray(identity) || identity[0] !== ownerId) continue
    thumbnailCache.delete(key)
    thumbnailCacheBytes -= value.bytes.byteLength
  }
}

async function createThumbnail(
  raw: Buffer,
  declaredMimeType: string | null,
  size: string,
): Promise<RenderedThumbnail> {
  const plan = planFileThumbnail(declaredMimeType, detectedFormat(raw), size)
  if (!plan) throw Object.assign(new Error('不是图片文件'), { statusCode: 415 })
  if (plan.kind === 'raw') return { bytes: raw, mimeType: plan.mimeType }
  try { return await resizeThumbnail(raw, plan.maxDimension, plan.quality) }
  catch { return { bytes: raw, mimeType: plan.mimeType } }
}

/** 路径文件没有数据库 ID，直接使用已授权打开的文件生成卡片缩略图。 */
export async function renderPathFileThumbnail(source: FileContentSource): Promise<RenderedThumbnail> {
  let raw: Buffer
  try {
    if (source.size === 0 || source.size > 8 * 1024 * 1024)
      throw new CoreError('not_found', '缩略图不可用')
    raw = Buffer.alloc(source.size)
    const { bytesRead } = await source.handle.read(raw, 0, raw.length, 0)
    if (bytesRead !== raw.length) throw new CoreError('not_found', '缩略图不可用')
  } finally {
    await source.handle.close()
  }
  let dimensions
  try { dimensions = imageSize(raw) } catch { throw new CoreError('not_found', '缩略图不可用') }
  if (dimensions.width * dimensions.height > 40_000_000)
    throw new CoreError('not_found', '缩略图不可用')
  return createThumbnail(raw, null, 'card')
}

export function registerFileThumbnailRoute(app: FastifyInstance, options: FileThumbnailOptions): void {
  app.get('/api/v1/files/by-path/thumb', {
    preHandler: options.requireUser,
  }, async (request, reply) => {
    const ownerId = options.ownerIdFromRequest(request)
    const key = fileStorageKey(request)
    const file = await options.operations.getFile(ownerId, key)
    if (file === null) throw new CoreError('not_found', '文件不存在')
    const metadata = fileMetadata(file)
    const declaredMime = (metadata.mimeType ?? '').toLowerCase().trim()
    if (!['', 'application/octet-stream', 'binary/octet-stream'].includes(declaredMime)
      && !planFileThumbnail(declaredMime, null, 'full'))
      throw Object.assign(new Error('不是图片文件'), { statusCode: 415 })
    const source = await options.operations.openContent(ownerId, key)
    if (!source) throw new CoreError('not_found', '物理文件丢失')
    let raw: Buffer
    try { raw = await source.handle.readFile() }
    finally { await source.handle.close() }

    const querySize = (request.query as Record<string, unknown>).size
    const size = typeof querySize === 'string' ? querySize : 'full'
    const cacheKey = JSON.stringify([ownerId, key, metadata.version, size])
    const cached = size === 'full' ? undefined : thumbnailCache.get(cacheKey)
    const rendered = cached ?? await createThumbnail(raw, metadata.mimeType ?? source.mimeType, size)
    if (!cached && size !== 'full' && rendered.bytes !== raw) cacheThumbnail(cacheKey, rendered)
    return reply
      .type(rendered.mimeType)
      .header('Cache-Control', 'private, max-age=86400')
      .send(rendered.bytes)
  })
}

export interface XlsxPreviewOperations {
  preview(ownerId: string, storageKey: string): Promise<{ version: number; sheets: unknown[] }>
  image(ownerId: string, storageKey: string, imageId: number): Promise<{ content: Uint8Array; mime: string }>
}

export interface XlsxPreviewRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: XlsxPreviewOperations
}

function pathInteger(value: string, label: string): number {
  const normalized = value.trim()
  if (!/^[+-]?\d+$/.test(normalized)) throw new CoreError('invalid_request', `${label} 无效`)
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed)) throw new CoreError('invalid_request', `${label} 无效`)
  return parsed
}

function sendPreviewError(error: unknown, reply: { code(statusCode: number): { send(payload: unknown): unknown } }): unknown {
  if (error instanceof XlsxPreviewError)
    return reply.code(error.statusCode).send({ detail: error.detail })
  throw error
}

export function registerXlsxPreviewRoutes(app: FastifyInstance, options: XlsxPreviewRouteOptions): void {
  app.get('/api/v1/files/by-path/xlsx-preview', { preHandler: options.requireUser }, async (request, reply) => {
    try {
      return await options.operations.preview(options.ownerIdFromRequest(request), fileStorageKey(request))
    } catch (error) { return sendPreviewError(error, reply) }
  })

  app.get<{ Params: { image_id: string } }>('/api/v1/files/by-path/xlsx-preview-image/:image_id', { preHandler: options.requireUser }, async (request, reply) => {
    try {
      const result = await options.operations.image(
        options.ownerIdFromRequest(request),
        fileStorageKey(request),
        pathInteger(request.params.image_id, '图片 ID'),
      )
      return reply.type(result.mime).header('Cache-Control', 'private, max-age=86400').send(Buffer.from(result.content))
    } catch (error) { return sendPreviewError(error, reply) }
  })
}

const MAX_FILE_BYTES = 256 * 1024 * 1024

type CentralEntry = XlsxPreviewArchiveEntry

const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

function decodeZipName(bytes: Buffer, utf8: boolean): string {
  if (utf8) return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return Array.from(bytes, byte => byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80] ?? '').join('')
}

function u64(buffer: Buffer, offset: number): bigint { return buffer.readBigUInt64LE(offset) }

function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new XlsxPreviewError(413, 'XLSX 文件超过预览大小限制')
  return Number(value)
}

/** 读取 ZIP central directory 的原始条目；JSZip 会按名称折叠重复项，因此在它解压前先保留 Python ZipFile 可见的条目清单。 */
function centralDirectory(raw: Buffer): CentralEntry[] {
  const lower = Math.max(0, raw.length - 65_557)
  let eocd = -1
  for (let offset = raw.length - 22; offset >= lower; offset--) {
    if (raw.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break }
  }
  if (eocd < 0) throw new XlsxPreviewError(400, '不是有效的 XLSX 文件')
  let count = raw.readUInt16LE(eocd + 10), directorySize = raw.readUInt32LE(eocd + 12), directoryOffset = raw.readUInt32LE(eocd + 16)
  if (raw.readUInt16LE(eocd + 4) !== 0 || raw.readUInt16LE(eocd + 6) !== 0
    || raw.readUInt16LE(eocd + 8) !== count) throw new XlsxPreviewError(400, '不是有效的 XLSX 文件')
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20
    if (locator < 0 || raw.readUInt32LE(locator) !== 0x07064b50 || raw.readUInt32LE(locator + 4) !== 0
      || raw.readUInt32LE(locator + 16) !== 1) throw new XlsxPreviewError(400, '不是有效的 XLSX 文件')
    const recordOffset = safeNumber(u64(raw, locator + 8))
    if (raw.readUInt32LE(recordOffset) !== 0x06064b50) throw new XlsxPreviewError(400, '不是有效的 XLSX 文件')
    if (raw.readUInt32LE(recordOffset + 16) !== 0 || raw.readUInt32LE(recordOffset + 20) !== 0)
      throw new XlsxPreviewError(400, '不是有效的 XLSX 文件')
    count = safeNumber(u64(raw, recordOffset + 32))
    directorySize = safeNumber(u64(raw, recordOffset + 40))
    directoryOffset = safeNumber(u64(raw, recordOffset + 48))
  }
  if (count > 20_000 || directoryOffset + directorySize > raw.length || directoryOffset > raw.length)
    throw new XlsxPreviewError(413, 'XLSX 文件条目数量超过预览限制')
  const entries: CentralEntry[] = []
  let offset = directoryOffset
  for (let index = 0; index < count; index++) {
    if (offset + 46 > raw.length || raw.readUInt32LE(offset) !== 0x02014b50) throw new XlsxPreviewError(400, '不是有效的 XLSX 文件')
    const flags = raw.readUInt16LE(offset + 8)
    let compressedSize = raw.readUInt32LE(offset + 20), size = raw.readUInt32LE(offset + 24)
    const nameLength = raw.readUInt16LE(offset + 28), extraLength = raw.readUInt16LE(offset + 30), commentLength = raw.readUInt16LE(offset + 32)
    const nameStart = offset + 46, extraStart = nameStart + nameLength, next = extraStart + extraLength + commentLength
    if (next > raw.length || next > directoryOffset + directorySize) throw new XlsxPreviewError(400, '不是有效的 XLSX 文件')
    let name: string
    try { name = decodeZipName(raw.subarray(nameStart, extraStart), Boolean(flags & 0x800)) }
    catch { throw new XlsxPreviewError(400, 'XLSX 文件名编码无效') }
    if (size === 0xffffffff || compressedSize === 0xffffffff) {
      const extraEnd = extraStart + extraLength
      let extra = extraStart, found = false
      while (extra + 4 <= extraEnd) {
        const type = raw.readUInt16LE(extra), length = raw.readUInt16LE(extra + 2), start = extra + 4, end = start + length
        if (end > extraEnd) throw new XlsxPreviewError(400, 'XLSX 文件结构不完整')
        if (type === 0x0001) {
          let cursor = start
          if (size === 0xffffffff) { size = safeNumber(u64(raw, cursor)); cursor += 8 }
          if (compressedSize === 0xffffffff) { compressedSize = safeNumber(u64(raw, cursor)); cursor += 8 }
          found = true; break
        }
        extra = end
      }
      if (!found) throw new XlsxPreviewError(400, 'XLSX 文件结构不完整')
    }
    entries.push({ name, size, compressedSize })
    offset = next
  }
  return entries
}

async function loadArchive(raw: Buffer): Promise<XlsxPreviewArchive> {
  if (raw.byteLength > MAX_FILE_BYTES) throw new XlsxPreviewError(413, 'XLSX 文件超过预览大小限制')
  const entries = centralDirectory(raw)
  try {
    const zip = await JSZip.loadAsync(raw, { checkCRC32: false, createFolders: false })
    const byName = new Map(Object.entries(zip.files).map(([name, file]) => [name, file]))
    return {
      rawSize: raw.byteLength,
      rawWorkbook: raw,
      entries,
      async read(name) {
        const file = byName.get(name)
        if (!file || file.dir) return null
        try { return await file.async('uint8array') } catch { throw new XlsxPreviewError(400, 'XLSX 文件内容损坏') }
      },
    }
  } catch (error) {
    if (error instanceof XlsxPreviewError) throw error
    throw new XlsxPreviewError(400, '不是有效的 XLSX 文件')
  }
}

type PreviewFileRow = QueryResultRow & { path: string; ext: string; version: number | string | null }

export function createPostgresXlsxPreviewOperations(pool: Pick<Pool, 'query'>, storageRoot: string) {
  const reader = createXlsxPreviewReader(async storageKey => {
    const opened = await openAuthorizedRelativeFile(storageKey, key => openLocalFile(storageRoot, key), error => error instanceof UnsafeLocalPathError)
    if (!opened) throw new CoreError('not_found', '物理文件丢失')
    try {
      if (opened.size > MAX_FILE_BYTES) throw new XlsxPreviewError(413, 'XLSX 文件超过预览大小限制')
      return await loadArchive(await opened.handle.readFile())
    } finally { await opened.handle.close() }
  })

  async function ownedXlsx(ownerId: string, storageKey: string): Promise<PreviewFileRow> {
    if (!isOwnedFilePath(ownerId, storageKey)) throw new CoreError('not_found', '文件不存在')
    const result = await pool.query<PreviewFileRow>(
      'SELECT path,ext,version FROM files WHERE path=$1 AND user_id=$2 AND deleted_at IS NULL',
      [storageKey, ownerId],
    )
    const file = result.rows[0]
    if (!file || !isOwnedFilePath(ownerId, file.path)) throw new CoreError('not_found', '文件不存在')
    if ((file.ext || '').toLowerCase() !== 'xlsx') throw new XlsxPreviewError(415, '仅支持 XLSX 文件')
    return file
  }

  return {
    async xlsxPreview(ownerId: string, storageKey: string) {
      const file = await ownedXlsx(ownerId, storageKey)
      return reader.preview(file.path, Number(file.version ?? 1))
    },
    async xlsxPreviewImage(ownerId: string, storageKey: string, imageId: number) {
      const file = await ownedXlsx(ownerId, storageKey)
      return reader.image(file.path, Number(file.version ?? 1), imageId)
    },
  }
}
