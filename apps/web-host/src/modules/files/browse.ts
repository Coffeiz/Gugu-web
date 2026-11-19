import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler, FastifyReply } from 'fastify'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { lookup } from 'mime-types'
import type { Pool, QueryResultRow } from 'pg'
import { normalizeOwnerId } from '../../shared/owner-context.js'
import type { FileHandle } from 'node:fs/promises'
import { resolveRelativeReferences } from '@gugu/core/files/relative-references'
import { openAuthorizedRelativeFile } from '@gugu/core/files/read'
import { openLocalFile, UnsafeLocalPathError } from '@gugu/fs/node'
import { isOwnedFileStorageKey } from './store.js'
import { createFileMigrationStorage } from './storage/migration.js'

export type FileSort = 'name' | 'type' | 'stage' | 'createdAt' | 'size' | 'id'

export interface FilePageQuery {
  limit: number; cursor: string | null; sortBy: FileSort; sortOrder: 'asc' | 'desc'
  space: string; projectId: number | null; folderId: number | null
  workspaceDirectoryId: number | null; mindMapId: number | null; ext: string | null; q: string | null
  queries?: readonly string[]; mode?: 'OR' | 'AND'
}

export interface FolderPageQuery {
  limit: number; cursor: string | null; sortBy: FileSort; sortOrder: 'asc' | 'desc'
  projectId: number | null; workspaceDirectoryId: number | null; parentId: number | null
}

export interface FileBrowserOperations {
  listFiles(ownerId: string, query: FilePageQuery): Promise<unknown>
  listFolders(ownerId: string, query: FolderPageQuery): Promise<unknown>
}

export interface FileBrowserRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileBrowserOperations
}

const sorts = new Set<FileSort>(['name', 'type', 'stage', 'createdAt', 'size', 'id'])

function integer(value: unknown, name: string, fallback: number | null): number | null {
  if (value === undefined || value === '') return fallback
  if (typeof value !== 'string' || !/^[+-]?\d+$/.test(value)) throw new CoreError('invalid_request', `${name} 无效`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new CoreError('invalid_request', `${name} 无效`)
  return parsed
}

function queryValue(request: FastifyRequest, name: string): unknown {
  return (request.query as Record<string, unknown>)[name]
}

function optionalString(request: FastifyRequest, name: string): string | null {
  const value = queryValue(request, name)
  if (value === undefined || value === '') return null
  if (typeof value !== 'string') throw new CoreError('invalid_request', `${name} 无效`)
  return value
}

function pageBasics(request: FastifyRequest) {
  const limit = integer(queryValue(request, 'limit'), 'limit', 100)!
  if (limit < 1 || limit > 200) throw new CoreError('invalid_request', 'limit 必须在 1 到 200 之间')
  const sortBy = queryValue(request, 'sort_by') ?? 'createdAt'
  const rawSortOrder = queryValue(request, 'sort_order')
  let sortOrder: 'asc' | 'desc'
  if (rawSortOrder === undefined || rawSortOrder === 'desc') sortOrder = 'desc'
  else if (rawSortOrder === 'asc') sortOrder = 'asc'
  else throw new CoreError('invalid_request', 'sort_order 无效')
  if (typeof sortBy !== 'string' || !sorts.has(sortBy as FileSort)) throw new CoreError('invalid_request', 'sort_by 无效')
  const cursor = queryValue(request, 'cursor')
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 4096))
    throw new CoreError('invalid_request', '分页游标无效或已失效')
  return { limit, cursor: (cursor as string | undefined) ?? null, sortBy: sortBy as FileSort, sortOrder }
}

export function registerFileBrowserRoutes(app: FastifyInstance, options: FileBrowserRouteOptions): void {
  const listFiles = async (request: FastifyRequest) => {
    const basics = pageBasics(request)
    const space = queryValue(request, 'space')
    if (typeof space !== 'string' || !space) throw new CoreError('invalid_request', '文件分页必须指定空间')
    return options.operations.listFiles(options.ownerIdFromRequest(request), {
      ...basics, space,
      projectId: integer(queryValue(request, 'project_id'), 'project_id', null),
      folderId: integer(queryValue(request, 'folder_id'), 'folder_id', null),
      workspaceDirectoryId: integer(queryValue(request, 'workspace_directory_id'), 'workspace_directory_id', null),
      mindMapId: integer(queryValue(request, 'mind_map_id'), 'mind_map_id', null),
      ext: optionalString(request, 'ext'), q: optionalString(request, 'q'),
    })
  }
  for (const path of ['/api/v1/files', '/api/v1/files/page'])
    app.get(path, { preHandler: options.requireUser }, listFiles)

  const listFolders = async (request: FastifyRequest) => {
    const basics = pageBasics(request)
    return options.operations.listFolders(options.ownerIdFromRequest(request), {
      ...basics,
      projectId: integer(queryValue(request, 'project_id'), 'project_id', null),
      workspaceDirectoryId: integer(queryValue(request, 'workspace_directory_id'), 'workspace_directory_id', null),
      parentId: integer(queryValue(request, 'parent_id'), 'parent_id', null),
    })
  }
  for (const path of ['/api/v1/folders', '/api/v1/folders/page'])
    app.get(path, { preHandler: options.requireUser }, listFolders)
}

type CursorValue = string | number

interface CursorPayload { v: 1; user: string; scope: Record<string, unknown>; value: CursorValue; id: number }

const aad = Buffer.from('gugu-file-page-cursor-v1')

function cursorKey(secret: string): Buffer { return createHash('sha256').update(`file-page-cursor:${secret}`).digest() }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function encodeCursor(secret: string, payload: CursorPayload): string {
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', cursorKey(secret), nonce)
  cipher.setAAD(aad); const encrypted = Buffer.concat([cipher.update(Buffer.from(canonicalJson(payload))), cipher.final()])
  return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString('base64url')
}

function decodeCursor(secret: string, token: string | null, user: string, scope: Record<string, unknown>): [CursorValue, number] | null {
  if (token === null) return null
  try {
    const bytes = Buffer.from(token, 'base64url'); if (bytes.length < 29) throw new Error()
    const decipher = createDecipheriv('aes-256-gcm', cursorKey(secret), bytes.subarray(0, 12))
    decipher.setAAD(aad); decipher.setAuthTag(bytes.subarray(-16))
    const payload = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString()) as CursorPayload
    if (payload.v !== 1 || payload.user !== user || canonicalJson(payload.scope) !== canonicalJson(scope)
      || !['string', 'number'].includes(typeof payload.value) || !Number.isSafeInteger(payload.id) || payload.id < 1) throw new Error()
    return [payload.value, payload.id]
  } catch { throw new CoreError('invalid_request', '分页游标无效或已失效') }
}

function orderOperator(order: 'asc' | 'desc') { return order === 'asc' ? '>' : '<' }

function orderDirection(order: 'asc' | 'desc') { return order.toUpperCase() }

function fileSort(sortBy: string, projectId: number | null): string {
  switch (sortBy) {
    case 'name': return 'file.display_name COLLATE "gugu_natural_zh"'
    case 'type': return `(CASE WHEN file.ext IN ('JPG','JPEG','PNG','GIF','WEBP','SVG','ICO','BMP','AVIF','HEIC','HEIF','TIF','TIFF') THEN 'image' WHEN file.ext IN ('MP4','MOV','AVI','MKV','WEBM','WMV','FLV','M4V') THEN 'video' WHEN file.ext IN ('MP3','WAV','FLAC','AAC','OGG','M4A','WMA','OPUS') THEN 'audio' WHEN file.ext IN ('XLS','XLSX','CSV','ODS','NUMBERS') THEN 'sheet' WHEN file.ext IN ('PPT','PPTX','KEY','ODP') THEN 'slide' WHEN file.ext IN ('ZIP','RAR','7Z','TAR','GZ','BZ2','XZ') THEN 'archive' WHEN file.ext IN ('JS','TS','JSX','TSX','VUE','PY','GO','RS','JAVA','CPP','C','CS','RB','SWIFT','PHP','KT','DART','SH','HTML','CSS','SCSS','LESS','XML','JSON','YAML','YML','TOML','MD','MDX','GRAPHQL') THEN 'code' ELSE 'doc' END || ':' || lower(file.ext))`
    case 'stage': return projectId !== null ? 'file.id' : 'file.stage_name COLLATE "gugu_natural_zh"'
    case 'createdAt': return 'file.created_at'
    case 'size': return 'file.size_bytes'
    default: return 'file.id'
  }
}

function folderSort(sortBy: string): string { return sortBy === 'name' || sortBy === 'type' ? 'folder.name COLLATE "gugu_natural_zh"' : 'folder.id' }

export function createPostgresFileBrowserOperations(pool: Pool, secret: string): FileBrowserOperations {
  return {
    async listFiles(rawOwner, query: FilePageQuery) {
      const user = normalizeOwnerId(rawOwner)
      if (query.space === 'project' && query.projectId === null) throw new CoreError('invalid_request', '项目文件分页必须指定项目')
      if (query.sortBy === 'stage' && query.projectId === null && !['personal', 'workspace'].includes(query.space))
        throw new CoreError('invalid_request', '阶段排序需要指定项目，或使用个人/Workspace 空间')
      const normalizedQueries = (query.queries?.length ? query.queries : query.q ? [query.q] : [])
        .map(value => value.trim().slice(0, 64)).filter(Boolean).slice(0, 8)
      const mode = query.mode === 'AND' ? 'AND' : 'OR'
      const scope = { resource: 'files', space: query.space, project_id: query.projectId, folder_id: query.folderId,
        workspace_directory_id: query.workspaceDirectoryId, mind_map_id: query.mindMapId,
        ext: query.ext?.toUpperCase() ?? null, queries: normalizedQueries, mode, sort_by: query.sortBy, sort_order: query.sortOrder }
      const sort = fileSort(query.sortBy, query.projectId); const direction = orderDirection(query.sortOrder)
      const scopeId = query.projectId || query.workspaceDirectoryId || query.mindMapId || 0
      const values: unknown[] = [user, query.space, query.projectId, query.workspaceDirectoryId, query.mindMapId,
        scopeId, query.folderId || 0, query.ext?.toUpperCase() ?? null]
      const filters = `file.user_id=$1 AND file.deleted_at IS NULL AND file.space=$2
        AND ($3::integer IS NULL OR file.project_id=$3) AND ($4::integer IS NULL OR file.workspace_directory_id=$4)
        AND ($5::integer IS NULL OR file.mind_map_id=$5)
        AND COALESCE(file.project_id,file.workspace_directory_id,file.mind_map_id,0)=$6
        AND COALESCE(file.folder_id,0)=$7
        AND ($8::text IS NULL OR file.ext=$8)`
      const queryConditions = normalizedQueries.map(term => {
        values.push(`%${term}%`)
        return `file.display_name ILIKE $${values.length}`
      })
      const queryFilter = queryConditions.length ? ` AND (${queryConditions.join(` ${mode} `)})` : ''
      const count = await pool.query<QueryResultRow & { total: number | string }>(
        `SELECT count(*)::int AS total FROM files file WHERE ${filters}${queryFilter}`, values)
      const boundary = decodeCursor(secret, query.cursor, user, scope)
      let boundarySql = ''
      const rowValues = [...values]
      if (boundary) {
        if (sort === 'file.id') {
          rowValues.push(boundary[1])
          boundarySql = `AND file.id ${orderOperator(query.sortOrder)} $${rowValues.length}`
        } else {
          rowValues.push(boundary[0], boundary[1])
          boundarySql = `AND (${sort},file.id) ${orderOperator(query.sortOrder)} ($${rowValues.length - 1},$${rowValues.length})`
        }
      }
      rowValues.push(query.limit + 1)
      const rows = await pool.query<QueryResultRow & Record<string, unknown>>(
        `SELECT file.id,file.display_name,file.ext,file.space,file.workspace_directory_id,file.project_id,
          project.name AS project_name,project.color AS project_color,file.stage_name,file.folder_id,folder.name AS folder_name,
          file.mind_map_id,file.size,file.size_bytes,file.mime_type,
          to_char(file.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at,
          CASE WHEN file.deleted_at IS NULL THEN NULL ELSE to_char(file.deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') END AS deleted_at,
          file.img_width,file.img_height,file.version,
          ${query.sortBy === 'createdAt' ? `to_char(file.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"')` : sort} AS page_sort FROM files file LEFT JOIN projects project ON project.id=file.project_id AND project.user_id=file.user_id
          LEFT JOIN folders folder ON folder.id=file.folder_id AND folder.user_id=file.user_id WHERE ${filters} ${boundarySql}
          ORDER BY ${sort} ${direction},file.id ${direction} LIMIT $${rowValues.length}`, rowValues,
      )
      const hasMore = rows.rows.length > query.limit; const page = rows.rows.slice(0, query.limit)
      const items = page.map((r) => ({ id:Number(r.id),displayName:r.display_name,ext:r.ext,space:r.space,
        workspaceDirectoryId:r.workspace_directory_id === null ? null : Number(r.workspace_directory_id),
        projectId:r.project_id === null ? null : Number(r.project_id),projectName:r.project_name,projectColor:browserColor(r.project_color),
        stageName:r.stage_name,folderId:r.folder_id === null ? null : Number(r.folder_id),folderName:r.folder_name,
        mindMapId:r.mind_map_id === null ? null : Number(r.mind_map_id),size:r.size,sizeBytes:Number(r.size_bytes),mimeType:r.mime_type,
        createdAt:browserTimestamp(r.created_at),deletedAt:r.deleted_at === null ? null : String(r.deleted_at),
        imgWidth:r.img_width === null ? null : Number(r.img_width),imgHeight:r.img_height === null ? null : Number(r.img_height),version:Number(r.version || 1) }))
      const last = page.at(-1)
      return { items, has_more:hasMore, next_cursor:hasMore && last ? encodeCursor(secret,{v:1,user,scope,value:last.page_sort as CursorValue,id:Number(last.id)}) : null,
        total: Number(count.rows[0]?.total ?? 0) }
    },
    async listFolders(rawOwner, query: FolderPageQuery) {
      const user=normalizeOwnerId(rawOwner)
      if (query.projectId !== null) { const r=await pool.query('SELECT id FROM projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',[query.projectId,user]); if(!r.rowCount) throw new CoreError('not_found','项目不存在') }
      if (query.workspaceDirectoryId !== null) { const r=await pool.query('SELECT id FROM workspace_directories WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',[query.workspaceDirectoryId,user]); if(!r.rowCount) throw new CoreError('not_found','Workspace 不存在') }
      if (query.projectId !== null && query.workspaceDirectoryId !== null) throw new CoreError('invalid_request','项目与 Workspace 目录不能同时指定')
      const scope={resource:'folders',project_id:query.projectId,workspace_directory_id:query.workspaceDirectoryId,parent_id:query.parentId,sort_by:query.sortBy,sort_order:query.sortOrder}
      const sort=folderSort(query.sortBy);const direction=orderDirection(query.sortOrder);const values:unknown[]=[user,query.projectId,query.workspaceDirectoryId,query.parentId]
      const boundary=decodeCursor(secret,query.cursor,user,scope);let boundarySql=''
      if(boundary){values.push(boundary[0],boundary[1]);boundarySql=`AND (${sort},folder.id) ${orderOperator(query.sortOrder)} ($${values.length-1},$${values.length})`}
      values.push(query.limit+1)
      const rows=await pool.query<QueryResultRow & Record<string,unknown>>(`SELECT folder.id,folder.project_id,folder.workspace_directory_id,folder.parent_id,folder.name,folder.version,${sort} AS page_sort,
        (SELECT count(*)::int FROM files f WHERE f.user_id=$1 AND f.folder_id=folder.id AND f.deleted_at IS NULL) AS file_count,
        (SELECT count(*)::int FROM folders child WHERE child.user_id=$1 AND child.parent_id=folder.id AND child.deleted_at IS NULL) AS folder_count
        FROM folders folder WHERE folder.user_id=$1 AND folder.deleted_at IS NULL AND folder.project_id IS NOT DISTINCT FROM $2
        AND folder.workspace_directory_id IS NOT DISTINCT FROM $3 AND folder.parent_id IS NOT DISTINCT FROM $4 ${boundarySql}
        ORDER BY ${sort} ${direction},folder.id ${direction} LIMIT $${values.length}`,values)
      const hasMore=rows.rows.length>query.limit;const page=rows.rows.slice(0,query.limit)
      const items=page.map(r=>({id:Number(r.id),projectId:r.project_id===null?null:Number(r.project_id),workspaceDirectoryId:r.workspace_directory_id===null?null:Number(r.workspace_directory_id),
        parentId:r.parent_id===null?null:Number(r.parent_id),name:r.name,fileCount:Number(r.file_count),folderCount:Number(r.folder_count),version:Number(r.version||1)}))
      const last=page.at(-1)
      return {items,has_more:hasMore,next_cursor:hasMore&&last?encodeCursor(secret,{v:1,user,scope,value:last.page_sort as CursorValue,id:Number(last.id)}):null}
    },
  }
}

function browserColor(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null
  return raw.match(/#[0-9a-fA-F]{3,6}/)?.[0] ?? raw
}

function browserTimestamp(raw: unknown): string {
  const value = String(raw)
  return `${value.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0{6}$/, '')}Z`
}

export interface FileContentSource {
  file: unknown
  handle: FileHandle
  size: number
  fileName: string
  mimeType: string
}

export interface FileReadOperations {
  getFile(ownerId: string, fileId: number): Promise<unknown | null>
  getFileLocation(ownerId: string, fileId: number): Promise<unknown | null>
  getSummary(ownerId: string, recentLimit: number): Promise<unknown>
  getLibraryCounts(ownerId: string): Promise<unknown>
  getStorage(ownerId: string): Promise<unknown>
  openContent(ownerId: string, fileId: number): Promise<FileContentSource | null>
  xlsxPreview?(ownerId: string, fileId: number): Promise<{ version: number; sheets: unknown[] }>
  xlsxPreviewImage?(ownerId: string, fileId: number, imageId: number): Promise<{ content: Uint8Array; mime: string }>
  resolveRelativePaths?(ownerId: string, fileId: number, paths: string[]): Promise<unknown[] | null>
}

export interface FileReadRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileReadOperations
}

function pathInteger(value: string): number {
  const normalized = value.trim()
  if (!/^[+-]?\d+$/.test(normalized)) throw new CoreError('invalid_request', '文件 ID 无效')
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed)) throw new CoreError('invalid_request', '文件 ID 无效')
  return parsed
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

function pathSegments(path: string): string[] {
  let decoded: string
  try { decoded = decodeURIComponent(path) } catch { return [] }
  const logicalPath = decoded.split(/[?#]/, 1)[0] ?? ''
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(decoded) || decoded.startsWith('//')
    || logicalPath.startsWith('/') || logicalPath.startsWith('\\')
    || logicalPath.includes('\\') || logicalPath.includes('\0')) return []
  return logicalPath.split('/').filter((part) => part !== '' && part !== '.')
}

function resolvePathsBody(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CoreError('invalid_request', '路径解析参数无效')
  const paths = (value as Record<string, unknown>).paths
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100
    || paths.some((item) => typeof item !== 'string' || !item || item.length > 1000))
    throw new CoreError('invalid_request', '路径解析列表无效')
  const pathList = paths as string[]
  const parts = pathList.map(pathSegments)
  if (parts.some((item) => item.length > 64) || parts.reduce((sum, item) => sum + item.length, 0) > 256)
    throw new CoreError('invalid_request', '批量路径最多解析 256 个片段，单条路径最多 64 个片段')
  return pathList
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

  if (options.operations.resolveRelativePaths) {
    app.post<{ Params: { fid: string } }>('/api/v1/files/:fid/resolve-paths', {
      preHandler: options.requireUser,
    }, async (request) => {
      const resolved = await options.operations.resolveRelativePaths!(
        options.ownerIdFromRequest(request), pathInteger(request.params.fid), resolvePathsBody(request.body),
      )
      if (resolved === null) throw new CoreError('not_found', '来源文件不存在')
      return resolved
    })
  }

  app.get<{ Params: { fid: string } }>('/api/v1/files/:fid/stream-url', { preHandler: options.requireUser }, async (request) => {
    const fileId = pathInteger(request.params.fid)
    const file = await options.operations.getFile(options.ownerIdFromRequest(request), fileId)
    if (file === null) throw new CoreError('not_found', '文件不存在')
    return { file, url: `/api/v1/files/${fileId}/stream` }
  })
  for (const [suffix, disposition] of [['download', 'attachment'], ['stream', 'inline']] as const) {
    app.get<{ Params: { fid: string } }>(`/api/v1/files/:fid/${suffix}`, {
      preHandler: options.requireUser,
    }, async (request, reply) => {
      const dl = (request.query as { dl?: unknown }).dl
      if (suffix === 'stream' && dl !== undefined && (typeof dl !== 'string' || !/^[+-]?\d+$/.test(dl.trim())))
        throw new CoreError('invalid_request', '下载参数无效')
      const source = await options.operations.openContent(
        options.ownerIdFromRequest(request), pathInteger(request.params.fid),
      )
      if (!source) throw new CoreError('not_found', '文件不存在')
      return sendContent(reply, request, source, suffix === 'stream' && dl !== undefined && Number(dl) !== 0 ? 'attachment' : disposition)
    })
  }

  app.get<{ Params: { fid: string } }>('/api/v1/files/:fid/location', { preHandler: options.requireUser }, async (request) => {
    const result = await options.operations.getFileLocation(
      options.ownerIdFromRequest(request), pathInteger(request.params.fid),
    )
    if (result === null) throw new CoreError('not_found', '文件不存在')
    return result
  })
  app.get<{ Params: { fid: string } }>('/api/v1/files/:fid', { preHandler: options.requireUser }, async (request) => {
    const result = await options.operations.getFile(
      options.ownerIdFromRequest(request), pathInteger(request.params.fid),
    )
    if (result === null) throw new CoreError('not_found', '文件不存在')
    return result
  })
}

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
  if (!isOwnedFileStorageKey(ownerId, storageKey))
    throw new CoreError('not_found', '文件不存在')

  const opened = await openAuthorizedRelativeFile(storageKey, key => openLocalFile(storageRoot, key),
    error => error instanceof UnsafeLocalPathError)
  return opened ? { file, ...opened, fileName, mimeType } : null
}

export function createPostgresFileReadOperations(
  pool: Pool,
  defaultStorageLimitBytes: number | null = null,
  storageRoot = '../Gugu-data/users',
): FileReadOperations {
  const migration = process.platform === 'linux' ? createFileMigrationStorage(storageRoot) : null
  async function migratedPersonal(ownerId: string, fileId: number) {
    const source = await migration?.openPersonalReference(ownerId, fileId)
    if (!source) return source
    try {
      const fileName = posix.basename(source.relativePath)
      const extension = posix.extname(fileName)
      const mimeType = lookup(fileName) || 'application/octet-stream'
      const stats = await source.handle.stat()
      const file = {
        id: fileId, displayName: extension ? fileName.slice(0, -extension.length) : fileName,
        ext: extension.slice(1).toUpperCase(), space: 'personal', workspaceDirectoryId: null,
        projectId: null, projectName: null, projectColor: null, stageName: '', folderId: null,
        folderName: null, mindMapId: null, size: `${source.size} B`, sizeBytes: source.size, mimeType,
        createdAt: stats.birthtime.toISOString(), deletedAt: null, imgWidth: null, imgHeight: null,
        version: stats.mtimeMs,
      }
      return { ...source, file, fileName, mimeType }
    } catch (error) {
      await source.handle.close()
      throw error
    }
  }

  return {
    async getFile(ownerId, fileId) {
      const migrated = await migratedPersonal(ownerId, fileId)
      if (migrated !== undefined) {
        await migrated?.handle.close()
        return migrated?.file ?? null
      }
      const row = await loadFile(pool, ownerId, fileId)
      return row ? fileResponse(row) : null
    },

    async openContent(ownerId, fileId) {
      const migrated = await migratedPersonal(ownerId, fileId)
      if (migrated !== undefined) return migrated
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
      const migrated = await migratedPersonal(ownerId, fileId)
      if (migrated !== undefined) {
        if (!migrated) return null
        await migrated.handle.close()
        return { file: migrated.file, folderPath: [], pathFile: { directoryId: 'personal', relativePath: migrated.relativePath } }
      }
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
      const byPath = new Map<string, FolderRow>()
      const key = (parts: readonly string[]) => JSON.stringify(parts)
      const sourcePath: string[] = []
      for (const folder of folders) { sourcePath.push(folder.name); byPath.set(key(sourcePath), folder) }
      const parentId = (parts: readonly string[]) => parts.length ? Number(byPath.get(key(parts))!.id) : null
      return resolveRelativeReferences(sourcePath, paths, {
        async fileAt(directory, name) {
          const file = await relativeFile(pool, ownerId, source, parentId(directory), name)
          return file ? fileResponse(file) : null
        },
        async folderAt(directory, name) {
          const folder = await relativeFolder(pool, ownerId, source, parentId(directory), name)
          if (!folder) return null
          byPath.set(key([...directory, name]), folder)
          return { id: Number(folder.id), projectId: nullableNumber(folder.project_id),
            workspaceDirectoryId: nullableNumber(folder.workspace_directory_id), parentId: nullableNumber(folder.parent_id),
            name: folder.name, fileCount: 0, folderCount: 0, version: Number(folder.version ?? 1) }
        },
      })
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

export interface FolderReadOperations {
  getFolder(ownerId: string, folderId: number): Promise<unknown | null>
  getFolderLocation(ownerId: string, folderId: number): Promise<unknown | null>
  resolvePaths?(ownerId: string, filters: FolderResolvePathFilters): Promise<unknown[]>
}

export interface FolderResolvePathFilters {
  projectId: number | null
  workspaceDirectoryId: number | null
  parentId: number | null
  paths: string[]
}

export interface FolderReadRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FolderReadOperations
}

function folderId(value: string): number {
  const normalized = value.trim()
  if (!/^[+-]?\d+$/.test(normalized)) throw new CoreError('invalid_request', '文件夹 ID 无效')
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed)) throw new CoreError('invalid_request', '文件夹 ID 无效')
  return parsed
}

function optionalInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) value = Number(value.trim())
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new CoreError('invalid_request', `${field} 无效`)
  return value
}

function folderPathsBody(value: unknown): FolderResolvePathFilters {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CoreError('invalid_request', '路径解析参数无效')
  const body = value as Record<string, unknown>
  const projectId = optionalInteger(body.projectId ?? body.project_id, 'projectId')
  const workspaceDirectoryId = optionalInteger(body.workspaceDirectoryId ?? body.workspace_directory_id, 'workspaceDirectoryId')
  const parentId = optionalInteger(body.parentId ?? body.parent_id, 'parentId')
  const paths = body.paths
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100
    || paths.some((item) => typeof item !== 'string' || !item || item.length > 1000))
    throw new CoreError('invalid_request', '路径列表无效')
  if (projectId !== null && workspaceDirectoryId !== null)
    throw new CoreError('invalid_request', '项目与 Workspace 目录不能同时指定')
  const normalized = (paths as string[]).map((path) => {
    let decoded = path
    try { decoded = decodeURIComponent(path) } catch { /* urllib.parse.unquote 保留非法百分号编码 */ }
    const parts = decoded.split('/').filter((part) => part !== '' && part !== '.')
    if (path.startsWith('/') || path.startsWith('\\') || path.includes('\\') || path.includes('\0')
      || parts.includes('..')) throw new CoreError('invalid_request', '目录路径必须是当前目录下的相对路径')
    return { path, parts }
  })
  if (normalized.reduce((sum, item) => sum + item.parts.length, 0) > 256
    || normalized.some((item) => item.parts.length > 64))
    throw new CoreError('invalid_request', '批量路径最多解析 256 个片段，单条路径最多 64 个片段')
  return { projectId, workspaceDirectoryId, parentId, paths: normalized.map((item) => item.path) }
}

export function registerFolderReadRoutes(app: FastifyInstance, options: FolderReadRouteOptions): void {
  if (options.operations.resolvePaths) {
    app.post('/api/v1/folders/resolve-paths', { preHandler: options.requireUser }, async (request) =>
      options.operations.resolvePaths!(options.ownerIdFromRequest(request), folderPathsBody(request.body)))
  }
  app.get<{ Params: { fid: string } }>('/api/v1/folders/:fid/location', { preHandler: options.requireUser }, async (request) => {
    const result = await options.operations.getFolderLocation(
      options.ownerIdFromRequest(request), folderId(request.params.fid),
    )
    if (result === null) throw new CoreError('not_found', '文件夹位置不存在')
    return result
  })
  app.get<{ Params: { fid: string } }>('/api/v1/folders/:fid', { preHandler: options.requireUser }, async (request) => {
    const result = await options.operations.getFolder(
      options.ownerIdFromRequest(request), folderId(request.params.fid),
    )
    if (result === null) throw new CoreError('not_found', '文件夹不存在')
    return result
  })
}

type FolderReadRow = QueryResultRow & {
  id: number | string
  project_id: number | string | null
  workspace_directory_id: number | string | null
  parent_id: number | string | null
  name: string
  version: number | string | null
  file_count?: number | string
}

function folderNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value)
}

function response(row: FolderReadRow, fileCount = 0) {
  return {
    id: Number(row.id),
    projectId: folderNumber(row.project_id),
    workspaceDirectoryId: folderNumber(row.workspace_directory_id),
    parentId: folderNumber(row.parent_id),
    name: row.name,
    fileCount,
    folderCount: 0,
    version: Number(row.version ?? 1),
  }
}

async function loadFolder(pool: Pool, ownerId: string, folderId: number): Promise<FolderReadRow | null> {
  const result = await pool.query<FolderReadRow>(
    `SELECT folder.id,folder.project_id,folder.workspace_directory_id,folder.parent_id,
            folder.name,folder.version,COUNT(file.id) AS file_count
     FROM folders folder
     LEFT JOIN files file
       ON file.folder_id=folder.id AND file.user_id=folder.user_id AND file.deleted_at IS NULL
     WHERE folder.id=$1 AND folder.user_id=$2 AND folder.deleted_at IS NULL
     GROUP BY folder.id`,
    [folderId, ownerId],
  )
  return result.rows[0] ?? null
}

async function loadAncestor(pool: Pool, ownerId: string, folderId: number): Promise<FolderReadRow | null> {
  const result = await pool.query<FolderReadRow>(
    `SELECT id,project_id,workspace_directory_id,parent_id,name,version
     FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
    [folderId, ownerId],
  )
  return result.rows[0] ?? null
}

function sameFolderScope(left: FolderReadRow, right: FolderReadRow): boolean {
  return folderNumber(left.project_id) === folderNumber(right.project_id)
    && folderNumber(left.workspace_directory_id) === folderNumber(right.workspace_directory_id)
}

function normalizedPath(pathValue: string): string[] {
  let decoded = pathValue
  try { decoded = decodeURIComponent(pathValue) } catch { /* Python unquote 保留非法百分号编码 */ }
  return decoded.split('/').filter((part) => part !== '' && part !== '.')
}

function folderPathResponse(row: FolderReadRow) {
  return response(row)
}

export function createPostgresFolderReadOperations(pool: Pool): FolderReadOperations {
  return {
    async getFolder(ownerId, folderId) {
      const folder = await loadFolder(pool, ownerId, folderId)
      return folder ? response(folder, Number(folder.file_count ?? 0)) : null
    },

    async getFolderLocation(ownerId, folderId) {
      const folder = await loadFolder(pool, ownerId, folderId)
      if (!folder) return null
      const chain = [folder]
      const seen = new Set<number>([Number(folder.id)])
      let parentId = folderNumber(folder.parent_id)
      while (parentId !== null && chain.length < 64) {
        if (seen.has(parentId)) throw new CoreError('not_found', '文件夹位置不存在')
        seen.add(parentId)
        const parent = await loadAncestor(pool, ownerId, parentId)
        if (!parent || !sameFolderScope(parent, folder)) throw new CoreError('not_found', '文件夹位置不存在')
        chain.push(parent)
        parentId = folderNumber(parent.parent_id)
      }
      if (parentId !== null) throw new CoreError('not_found', '文件夹位置超过允许的层级')
      return {
        folder: response(folder, Number(folder.file_count ?? 0)),
        ancestors: chain.slice(1).reverse().map((ancestor) => response(ancestor)),
      }
    },

    async resolvePaths(ownerId, filters: FolderResolvePathFilters) {
      const { projectId, workspaceDirectoryId, parentId, paths } = filters
      if (projectId !== null && workspaceDirectoryId !== null) return []
      if (projectId !== null) {
        const project = await pool.query(
          'SELECT 1 FROM projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [projectId, ownerId],
        )
        if (!project.rows.length) throw new CoreError('not_found', '项目不存在')
      }
      if (workspaceDirectoryId !== null) {
        const workspace = await pool.query(
          'SELECT 1 FROM workspace_directories WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
          [workspaceDirectoryId, ownerId],
        )
        if (!workspace.rows.length) throw new CoreError('not_found', 'Workspace 不存在')
      }
      if (parentId !== null) {
        const parent = await pool.query<FolderReadRow>(
          `SELECT id,project_id,workspace_directory_id,parent_id,name,version
           FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [parentId, ownerId],
        )
        const row = parent.rows[0]
        if (!row || folderNumber(row.project_id) !== projectId
          || folderNumber(row.workspace_directory_id) !== workspaceDirectoryId) return []
      }

      const parsed = paths.map((path) => ({ path, parts: normalizedPath(path) }))
      const states = new Map<string, number | null>([['', parentId]])
      const found = new Map<number, FolderReadRow>()
      const maxDepth = Math.max(0, ...parsed.map((item) => item.parts.length))
      for (let depth = 0; depth < maxDepth; depth++) {
        const pairs = new Map<string, { parent: number; name: string }>()
        for (const item of parsed) {
          if (item.parts.length <= depth) continue
          const prefix = item.parts.slice(0, depth).join('/')
          if (!states.has(prefix)) continue
          const parent = states.get(prefix) ?? 0
          const name = item.parts[depth]!
          pairs.set(`${parent}\0${name}`, { parent, name })
        }
        if (!pairs.size) break
        const targets = [...pairs.values()]
        const rows = await pool.query<FolderReadRow>(
          `SELECT folder.id,folder.project_id,folder.workspace_directory_id,folder.parent_id,folder.name,folder.version
           FROM folders folder
           JOIN unnest($4::integer[],$5::text[]) AS wanted(parent_key,folder_name)
             ON COALESCE(folder.parent_id,0)=wanted.parent_key AND folder.name=wanted.folder_name
           WHERE folder.user_id=$1 AND folder.deleted_at IS NULL
             AND folder.project_id IS NOT DISTINCT FROM $2
             AND folder.workspace_directory_id IS NOT DISTINCT FROM $3
           LIMIT 256`,
          [ownerId, projectId, workspaceDirectoryId, targets.map((item) => item.parent), targets.map((item) => item.name)],
        )
        const byPair = new Map(rows.rows.map((row) => [`${Number(row.parent_id ?? 0)}\0${row.name}`, row]))
        const next = new Map<string, number>()
        for (const item of parsed) {
          if (item.parts.length <= depth) continue
          const prefix = item.parts.slice(0, depth).join('/')
          if (!states.has(prefix)) continue
          const folder = byPair.get(`${Number(states.get(prefix) ?? 0)}\0${item.parts[depth]}`)
          if (!folder) continue
          found.set(Number(folder.id), folder)
          next.set(item.parts.slice(0, depth + 1).join('/'), Number(folder.id))
        }
        states.clear()
        for (const [prefix, id] of next) states.set(prefix, id)
        if (!states.size) break
      }
      return [...found.values()].map(folderPathResponse)
    },
  }
}
