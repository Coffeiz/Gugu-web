import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler, FastifyReply } from 'fastify'
import type { Pool, QueryResultRow } from 'pg'
import { normalizeOwnerId } from '../../shared/owner-context.js'
import type { FileHandle } from 'node:fs/promises'
import { openAuthorizedRelativeFile } from '@gugu/core/files/read'
import { createLocalFileTree, openLocalFile, UnsafeLocalPathError } from '@gugu/fs/node'
import { isOwnedFileStorageKey } from './store.js'
import { projectFileStorageKey } from './paths.js'
import { createDiskTrash } from './trash/disk.js'
import { readPathDirectoryOverview, resolveFileDirectoryRoot } from '../workspaces/files.js'

export interface FileContentSource {
  file: unknown
  handle: FileHandle
  size: number
  fileName: string
  mimeType: string
}

export interface FileReadOperations {
  getFile(ownerId: string, storageKey: string): Promise<unknown | null>
  getFileLocation(ownerId: string, storageKey: string): Promise<unknown | null>
  getSummary(ownerId: string, recentLimit: number): Promise<unknown>
  getLibraryCounts(ownerId: string): Promise<unknown>
  getStorage(ownerId: string): Promise<unknown>
  openContent(ownerId: string, storageKey: string): Promise<FileContentSource | null>
  xlsxPreview?(ownerId: string, storageKey: string): Promise<{ version: number; sheets: unknown[] }>
  xlsxPreviewImage?(ownerId: string, storageKey: string, imageId: number): Promise<{ content: Uint8Array; mime: string }>
}

export interface FileReadRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileReadOperations
}

function storageKey(request: FastifyRequest): string {
  const value = (request.query as Record<string, unknown>).path
  if (typeof value !== 'string' || !value || value.length > 4096 || value.startsWith('/')
    || value.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')))
    throw new CoreError('invalid_request', '文件路径无效')
  return value
}

function recentLimit(request: FastifyRequest): number {
  const raw = (request.query as Record<string, unknown>).recent_limit
  if (raw === undefined) return 12
  if (typeof raw !== 'string' || !/^[+-]?\d+$/.test(raw.trim()))
    throw new CoreError('invalid_request', 'recent_limit 无效')
  const limit = Number(raw.trim())
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30)
    throw new CoreError('invalid_request', 'recent_limit 必须在 1 到 30 之间')
  return limit
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | null {
  if (value === undefined) return { start: 0, end: Math.max(0, size - 1) }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || size === 0 || (!match[1] && !match[2])) return null
  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) return null
    return { start: Math.max(0, size - suffixLength), end: size - 1 }
  }
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
    || start < 0 || requestedEnd < start || start >= size) return null
  return { start, end: Math.min(size - 1, requestedEnd) }
}

function encodedFileName(fileName: string): string {
  return encodeURIComponent(fileName).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

function dispositionHeader(disposition: 'inline' | 'attachment', fileName: string): string {
  return disposition === 'inline'
    ? 'inline'
    : `attachment; filename*=UTF-8''${encodedFileName(fileName)}`
}

export async function sendContent(
  reply: FastifyReply,
  request: FastifyRequest,
  source: FileContentSource,
  disposition: 'inline' | 'attachment',
  cacheControl = 'private, max-age=300',
) {
  if (source.size === 0 && request.headers.range === undefined) {
    reply
      .code(200)
      .type(source.mimeType || 'application/octet-stream')
      .header('Accept-Ranges', 'bytes')
      .header('Content-Length', '0')
      .header('Content-Disposition', dispositionHeader(disposition, source.fileName))
      .header('Cache-Control', cacheControl)
    return reply.send(source.handle.createReadStream({ autoClose: true }))
  }
  const range = parseRange(request.headers.range, source.size)
  if (!range) {
    await source.handle.close()
    return reply.code(416).header('Content-Range', `bytes */${source.size}`).send()
  }
  const partial = request.headers.range !== undefined
  const length = range.end - range.start + 1
  reply
    .code(partial ? 206 : 200)
    .type(source.mimeType || 'application/octet-stream')
    .header('Accept-Ranges', 'bytes')
    .header('Content-Length', String(length))
    .header('Content-Disposition', dispositionHeader(disposition, source.fileName))
    .header('Cache-Control', cacheControl)
  if (partial) reply.header('Content-Range', `bytes ${range.start}-${range.end}/${source.size}`)
  return reply.send(source.handle.createReadStream({ start: range.start, end: range.end, autoClose: true }))
}

export function registerFileReadRoutes(app: FastifyInstance, options: FileReadRouteOptions): void {
  app.get('/api/v1/files/summary', { preHandler: options.requireUser }, async (request) =>
    options.operations.getSummary(options.ownerIdFromRequest(request), recentLimit(request)))
  app.get('/api/v1/files/library-counts', { preHandler: options.requireUser }, async (request) =>
    options.operations.getLibraryCounts(options.ownerIdFromRequest(request)))
  app.get('/api/v1/files/storage', { preHandler: options.requireUser }, async (request) =>
    options.operations.getStorage(options.ownerIdFromRequest(request)))

  app.get('/api/v1/files/by-path/stream-url', { preHandler: options.requireUser }, async (request) => {
    const key = storageKey(request)
    const file = await options.operations.getFile(options.ownerIdFromRequest(request), key)
    if (file === null) throw new CoreError('not_found', '文件不存在')
    return { file, url: `/api/v1/files/by-path/stream?${new URLSearchParams({ path: key })}` }
  })
  for (const [suffix, disposition] of [['download', 'attachment'], ['stream', 'inline']] as const) {
    app.get(`/api/v1/files/by-path/${suffix}`, {
      preHandler: options.requireUser,
    }, async (request, reply) => {
      const dl = (request.query as { dl?: unknown }).dl
      if (suffix === 'stream' && dl !== undefined && (typeof dl !== 'string' || !/^[+-]?\d+$/.test(dl.trim())))
        throw new CoreError('invalid_request', '下载参数无效')
      const source = await options.operations.openContent(
        options.ownerIdFromRequest(request), storageKey(request),
      )
      if (!source) throw new CoreError('not_found', '文件不存在')
      return sendContent(reply, request, source, suffix === 'stream' && dl !== undefined && Number(dl) !== 0 ? 'attachment' : disposition)
    })
  }

  app.get('/api/v1/files/by-path/location', { preHandler: options.requireUser }, async (request) => {
    const result = await options.operations.getFileLocation(
      options.ownerIdFromRequest(request), storageKey(request),
    )
    if (result === null) throw new CoreError('not_found', '文件不存在')
    return result
  })
  app.get('/api/v1/files/by-path', { preHandler: options.requireUser }, async (request) => {
    const result = await options.operations.getFile(
      options.ownerIdFromRequest(request), storageKey(request),
    )
    if (result === null) throw new CoreError('not_found', '文件不存在')
    return result
  })
}

type FileRow = QueryResultRow & Record<string, unknown> & {
  path: string
  display_name: string
  ext: string
  space: string
  workspace_directory_id: number | string | null
  project_id: number | string | null
  project_name: string | null
  project_color: string | null
  stage_name: string
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

function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value)
}

function colorValue(raw: string | null): string | null {
  if (!raw) return null
  return raw.match(/#[0-9a-fA-F]{3,6}/)?.[0] ?? raw
}

function isoUtc(raw: string | Date): string {
  const value = raw instanceof Date ? raw.toISOString() : raw
  return value.endsWith('Z') ? value : `${value}Z`
}

function fileResponse(row: FileRow) {
  return {
    filePath: row.path,
    displayName: row.display_name,
    ext: row.ext,
    space: row.space,
    workspaceDirectoryId: nullableNumber(row.workspace_directory_id),
    projectId: nullableNumber(row.project_id),
    projectName: row.project_name,
    projectColor: colorValue(row.project_color),
    stageName: row.stage_name,
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

const fileProjection = `file.display_name,file.ext,file.space,file.workspace_directory_id,
  file.path,file.project_id,project.name AS project_name,project.color AS project_color,file.stage_name,
  file.mind_map_id,file.size,file.size_bytes,
  file.mime_type,to_char(file.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at,
  CASE WHEN file.deleted_at IS NULL THEN NULL ELSE to_char(file.deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') END AS deleted_at,
  file.img_width,file.img_height,file.version`

async function loadFile(pool: Pool, ownerId: string, storageKey: string): Promise<FileRow | null> {
  if (!isOwnedFileStorageKey(ownerId, storageKey)) return null
  const result = await pool.query<FileRow>(
    `SELECT ${fileProjection}
     FROM files file
     LEFT JOIN projects project ON project.id=file.project_id AND project.user_id=file.user_id
     WHERE file.path=$1 AND file.user_id=$2 AND file.deleted_at IS NULL`,
    [storageKey, ownerId],
  )
  return result.rows[0] ?? null
}

export async function openOwnedLocalFile(
  storageRoot: string,
  ownerId: string,
  storageKey: string,
  file: unknown,
  fileName: string,
  mimeType: string,
): Promise<FileContentSource | null> {
  if (!isOwnedFileStorageKey(ownerId, storageKey))
    throw new CoreError('not_found', '文件不存在')

  const opened = await openAuthorizedRelativeFile(storageKey, key => openLocalFile(storageRoot, key),
    error => error instanceof UnsafeLocalPathError)
  return opened ? { file, ...opened, fileName, mimeType } : null
}

export function createPostgresFileReadOperations(
  pool: Pool,
  storageRoot = '../Gugu-data/users',
): FileReadOperations {
  return {
    async getFile(ownerId, key) {
      const row = await loadFile(pool, ownerId, key)
      return row ? fileResponse(row) : null
    },

    async openContent(ownerId, key) {
      const row = await loadFile(pool, ownerId, key)
      if (!row) return null
      return openOwnedLocalFile(
        storageRoot,
        ownerId,
        row.path,
        fileResponse(row),
        `${row.display_name}.${row.ext.toLowerCase()}`,
        row.mime_type || 'application/octet-stream',
      )
    },

    async getFileLocation(ownerId, key) {
      const file = await loadFile(pool, ownerId, key)
      if (!file) return null
      const directory = file.space === 'personal' ? 'personal' as const
        : file.space === 'project' && file.project_id != null ? { projectId: Number(file.project_id) }
        : file.space === 'workspace' && file.workspace_directory_id != null ? Number(file.workspace_directory_id) : null
      if (directory !== null) {
        const root = await resolveFileDirectoryRoot(pool, ownerId, directory)
        const prefix = root + '/'
        if (!file.path.startsWith(prefix)) throw new CoreError('not_found', '文件位置不存在')
        const relativePath = file.path.slice(prefix.length)
        if (!relativePath || relativePath.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\')))
          throw new CoreError('not_found', '文件位置不存在')
        return { file: fileResponse(file), pathFile: { directoryId: typeof directory === 'object' ? `project:${directory.projectId}` : directory, relativePath } }
      }
      throw new CoreError('not_found', '文件位置不存在')
    },

    async getSummary(ownerId, recentLimit) {
      const result = await pool.query<FileRow>(
        `SELECT ${fileProjection}
         FROM files file
         LEFT JOIN projects project ON project.id=file.project_id AND project.user_id=file.user_id
             WHERE file.user_id=$1 AND file.deleted_at IS NULL
         ORDER BY file.created_at DESC,file.path LIMIT $2`,
        [ownerId, recentLimit],
      )
      return { recentFiles: result.rows.map(fileResponse) }
    },

    async getLibraryCounts(ownerId) {
      const owner = normalizeOwnerId(ownerId)
      const personal = await createLocalFileTree(storageRoot, `${owner}/个人文件`).list('') ?? []
      const projects = await pool.query<{ id: number; name: string; start_date: unknown; created_at: unknown }>(
        'SELECT id,name,start_date,created_at FROM projects WHERE user_id=$1 AND deleted_at IS NULL', [owner],
      )
      let projectFileCount = 0
      let projectFolderCount = 0
      for (const project of projects.rows) {
        const key = projectFileStorageKey(owner, project.id, project.name, project.start_date, project.created_at)
        const overview = await readPathDirectoryOverview(storageRoot, key)
        projectFileCount += overview.total
        projectFolderCount += overview.totalFolders
      }
      const trash = await createDiskTrash(storageRoot, (identity, directory) => resolveFileDirectoryRoot(pool, identity, directory)).list(owner)
      return {
        personalFileCount: personal.filter(entry => entry.kind === 'file').length,
        personalFolderCount: personal.filter(entry => entry.kind === 'directory').length,
        projectFileCount, projectFolderCount,
        trashFileCount: trash.filter(entry => entry.kind === 'file').length,
        trashFolderCount: trash.filter(entry => entry.kind === 'directory').length,
      }
    },

    async getStorage(ownerId) {
      const owner = normalizeOwnerId(ownerId)
      let used = 0
      for (const space of ['个人文件', '项目文件', 'workspace', '思维', '素材板']) {
        const tree = createLocalFileTree(storageRoot, `${owner}/${space}`)
        const pending = ['']
        while (pending.length) {
          const entries = await tree.list(pending.pop()!)
          if (!entries) continue
          for (const entry of entries) {
            if (entry.kind === 'directory') pending.push(entry.relativePath)
            else {
              used += entry.size
              if (!Number.isSafeInteger(used)) throw new Error('文件用量超出支持范围')
            }
          }
        }
      }
      return { used_bytes: used }
    },
  }
}
