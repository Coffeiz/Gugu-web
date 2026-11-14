import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export type FileSort = 'name' | 'type' | 'stage' | 'createdAt' | 'size' | 'id'
export interface FilePageQuery {
  limit: number; cursor: string | null; sortBy: FileSort; sortOrder: 'asc' | 'desc'
  space: string; projectId: number | null; folderId: number | null
  workspaceDirectoryId: number | null; mindMapId: number | null; ext: string | null; q: string | null
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
