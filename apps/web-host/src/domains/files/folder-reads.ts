import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

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

function resolvePathsBody(value: unknown): FolderResolvePathFilters {
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
      options.operations.resolvePaths!(options.ownerIdFromRequest(request), resolvePathsBody(request.body)))
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
