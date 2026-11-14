import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export interface WorkspaceDirectoryCard {
  id: number
  name: string
  directory_name: string
  is_default: boolean
  is_system: boolean
  file_count: number
  folder_count: number
  bound_session_count: number
  bound_task_count: number
}

export interface WorkspaceDirectoryOperations {
  list(ownerId: string): Promise<WorkspaceDirectoryCard[]>
  create(ownerId: string, name: string): Promise<WorkspaceDirectoryCard>
  update(ownerId: string, directoryId: number, name: string): Promise<WorkspaceDirectoryCard>
  previewDelete(ownerId: string, directoryId: number): Promise<WorkspaceDirectoryCard>
  delete(ownerId: string, directoryId: number): Promise<{ ok: true; workspaceDirectoryId: number }>
}

export interface WorkspaceDirectoryRouteOptions {
  /** 认证必须先于 ownerIdFromRequest 与数据操作执行。 */
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: WorkspaceDirectoryOperations
}

function pathId(value: string): number {
  if (!/^[+-]?\d+$/.test(value)) throw new CoreError('invalid_request', 'Workspace ID 无效')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed))
    throw new CoreError('invalid_request', 'Workspace ID 无效')
  return parsed
}

function directoryName(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new CoreError('invalid_request', '请求内容必须是对象')
  const name = (body as Record<string, unknown>).name
  if (typeof name !== 'string') throw new CoreError('invalid_request', '名称必须是文本')
  if (Array.from(name).length > 200)
    throw new CoreError('invalid_request', '名称长度不能超过 200 个字符')
  const normalized = name.trim()
  if (!normalized) throw new CoreError('invalid_request', '名称不能为空')
  if (/[\\/:*?"<>|]/.test(normalized))
    throw new CoreError('invalid_request', '名称不能包含以下字符：\\ / : * ? " < > |')
  return normalized
}

function cardResponse(row: WorkspaceDirectoryCard) {
  return {
    id: row.id,
    name: row.name,
    directoryName: row.directory_name,
    isDefault: row.is_default,
    isSystem: row.is_system,
    fileCount: row.file_count,
    folderCount: row.folder_count,
    boundSessionCount: row.bound_session_count,
    boundTaskCount: row.bound_task_count,
  }
}

/** 注册 Python workspace_directories_router 对应的五条用户接口。 */
export function registerWorkspaceDirectoryRoutes(
  app: FastifyInstance,
  options: WorkspaceDirectoryRouteOptions,
): void {
  app.get('/api/v1/workspace-directories', {
    preHandler: options.requireUser,
  }, async (request) => {
    const ownerId = options.ownerIdFromRequest(request)
    return (await options.operations.list(ownerId)).map(cardResponse)
  })

  app.post('/api/v1/workspace-directories', {
    preHandler: options.requireUser,
  }, async (request, reply) => {
    const ownerId = options.ownerIdFromRequest(request)
    const name = directoryName(request.body)
    return reply.code(201).send(cardResponse(await options.operations.create(ownerId, name)))
  })

  app.patch<{ Params: { directory_id: string } }>('/api/v1/workspace-directories/:directory_id', {
    preHandler: options.requireUser,
  }, async (request) => {
    const ownerId = options.ownerIdFromRequest(request)
    const id = pathId(request.params.directory_id)
    const name = directoryName(request.body)
    return cardResponse(await options.operations.update(ownerId, id, name))
  })

  // Python 当前返回 raw dict（snake_case），而 list/create/update 由响应模型转 camelCase。
  app.get<{ Params: { directory_id: string } }>('/api/v1/workspace-directories/:directory_id/delete-preview', {
    preHandler: options.requireUser,
  }, async (request) => {
    const ownerId = options.ownerIdFromRequest(request)
    return options.operations.previewDelete(ownerId, pathId(request.params.directory_id))
  })

  app.delete<{ Params: { directory_id: string } }>('/api/v1/workspace-directories/:directory_id', {
    preHandler: options.requireUser,
  }, async (request) => {
    const ownerId = options.ownerIdFromRequest(request)
    return options.operations.delete(ownerId, pathId(request.params.directory_id))
  })
}
