import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { CoreError } from '@gugu/core'
import type { Pool, QueryResultRow } from 'pg'
import { normalizeOwnerId } from '../../adapters/owner-context.js'
import type { FileBrowserOperations, FilePageQuery, FolderPageQuery } from './browser.js'

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
      const scope = { resource: 'files', space: query.space, project_id: query.projectId, folder_id: query.folderId,
        workspace_directory_id: query.workspaceDirectoryId, mind_map_id: query.mindMapId,
        ext: query.ext?.toUpperCase() ?? null, q: query.q, sort_by: query.sortBy, sort_order: query.sortOrder }
      const sort = fileSort(query.sortBy, query.projectId); const direction = orderDirection(query.sortOrder)
      const scopeId = query.projectId || query.workspaceDirectoryId || query.mindMapId || 0
      const values: unknown[] = [user, query.space, query.projectId, query.workspaceDirectoryId, query.mindMapId,
        scopeId, query.folderId || 0, query.ext?.toUpperCase() ?? null, query.q ? `%${query.q}%` : null]
      const filters = `file.user_id=$1 AND file.deleted_at IS NULL AND file.space=$2
        AND ($3::integer IS NULL OR file.project_id=$3) AND ($4::integer IS NULL OR file.workspace_directory_id=$4)
        AND ($5::integer IS NULL OR file.mind_map_id=$5)
        AND COALESCE(file.project_id,file.workspace_directory_id,file.mind_map_id,0)=$6
        AND COALESCE(file.folder_id,0)=$7
        AND ($8::text IS NULL OR file.ext=$8) AND ($9::text IS NULL OR file.display_name ILIKE $9)`
      const boundary = decodeCursor(secret, query.cursor, user, scope)
      let boundarySql = ''
      if (boundary) {
        if (sort === 'file.id') {
          values.push(boundary[1])
          boundarySql = `AND file.id ${orderOperator(query.sortOrder)} $${values.length}`
        } else {
          values.push(boundary[0], boundary[1])
          boundarySql = `AND (${sort},file.id) ${orderOperator(query.sortOrder)} ($${values.length - 1},$${values.length})`
        }
      }
      values.push(query.limit + 1)
      const rows = await pool.query<QueryResultRow & Record<string, unknown>>(
        `SELECT file.id,file.display_name,file.ext,file.space,file.workspace_directory_id,file.project_id,
          project.name AS project_name,project.color AS project_color,file.stage_name,file.folder_id,folder.name AS folder_name,
          file.mind_map_id,file.size,file.size_bytes,file.mime_type,
          to_char(file.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at,
          CASE WHEN file.deleted_at IS NULL THEN NULL ELSE to_char(file.deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') END AS deleted_at,
          file.img_width,file.img_height,file.version,
          ${query.sortBy === 'createdAt' ? `to_char(file.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"')` : sort} AS page_sort FROM files file LEFT JOIN projects project ON project.id=file.project_id
          LEFT JOIN folders folder ON folder.id=file.folder_id WHERE ${filters} ${boundarySql}
          ORDER BY ${sort} ${direction},file.id ${direction} LIMIT $${values.length}`, values,
      )
      const hasMore = rows.rows.length > query.limit; const page = rows.rows.slice(0, query.limit)
      const items = page.map((r) => ({ id:Number(r.id),displayName:r.display_name,ext:r.ext,space:r.space,
        workspaceDirectoryId:r.workspace_directory_id === null ? null : Number(r.workspace_directory_id),
        projectId:r.project_id === null ? null : Number(r.project_id),projectName:r.project_name,projectColor:colorValue(r.project_color),
        stageName:r.stage_name,folderId:r.folder_id === null ? null : Number(r.folder_id),folderName:r.folder_name,
        mindMapId:r.mind_map_id === null ? null : Number(r.mind_map_id),size:r.size,sizeBytes:Number(r.size_bytes),mimeType:r.mime_type,
        createdAt:isoUtc(r.created_at),deletedAt:r.deleted_at === null ? null : String(r.deleted_at),
        imgWidth:r.img_width === null ? null : Number(r.img_width),imgHeight:r.img_height === null ? null : Number(r.img_height),version:Number(r.version || 1) }))
      const last = page.at(-1)
      return { items, has_more:hasMore, next_cursor:hasMore && last ? encodeCursor(secret,{v:1,user,scope,value:last.page_sort as CursorValue,id:Number(last.id)}) : null }
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

function colorValue(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null
  return raw.match(/#[0-9a-fA-F]{3,6}/)?.[0] ?? raw
}

function isoUtc(raw: unknown): string {
  const value = String(raw)
  return `${value.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0{6}$/, '')}Z`
}
