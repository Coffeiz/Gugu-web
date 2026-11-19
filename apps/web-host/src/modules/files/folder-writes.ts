import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export interface FolderCreateInput {
  name: string
  projectId: number | null
  workspaceDirectoryId: number | null
  parentId: number | null
}

export interface FolderRenameInput {
  name: string
  version: number
}

export interface FolderMoveInput {
  parentId: number | null
  version: number
  projectId: number | null
  projectSet: boolean
  workspaceDirectoryId: number | null
  workspaceDirectorySet: boolean
}

export interface FolderWriteMetadata {
  undoContextId: string | null
  origin: string | null
}

export interface FolderWriteOperations {
  create(ownerId: string, input: FolderCreateInput, metadata: FolderWriteMetadata): Promise<unknown>
  rename(ownerId: string, folderId: number, input: FolderRenameInput, metadata: FolderWriteMetadata): Promise<unknown>
  move(ownerId: string, folderId: number, input: FolderMoveInput, metadata: FolderWriteMetadata): Promise<unknown>
}

export interface FolderWriteRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FolderWriteOperations
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new CoreError('invalid_request', '请求体无效')
  return body as Record<string, unknown>
}

function integer(value: unknown, name: string, nullable: boolean): number | null {
  if (nullable && (value === undefined || value === null)) return null
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (!/^[+-]?\d+(?:\.0+)?$/.test(normalized)) throw new CoreError('invalid_request', `${name} 无效`)
    const parsed = Number(normalized)
    if (!Number.isSafeInteger(parsed)) throw new CoreError('invalid_request', `${name} 无效`)
    return parsed
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new CoreError('invalid_request', `${name} 无效`)
  return value
}

function pathInteger(value: string): number {
  const normalized = value.trim()
  if (!/^[+-]?\d+$/.test(normalized)) throw new CoreError('invalid_request', '文件夹 ID 无效')
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed)) throw new CoreError('invalid_request', '文件夹 ID 无效')
  return parsed
}

function folderName(value: unknown): string {
  if (typeof value !== 'string') throw new CoreError('invalid_request', '名称无效')
  const name = value.trim()
  if (!name) throw new CoreError('invalid_request', '名称不能为空')
  if (name === '.' || name === '..') throw new CoreError('invalid_request', '名称不能是路径段')
  if (name.includes('\0')) throw new CoreError('invalid_request', '名称包含不支持的字符')
  if (/[\\/:*?"<>|]/.test(name)) throw new CoreError('invalid_request', '名称包含不支持的字符')
  return name
}

function metadata(request: FastifyRequest): FolderWriteMetadata {
  const undo = request.headers['x-undo-context-id']
  const origin = request.headers['x-client-id']
  return {
    undoContextId: typeof undo === 'string' ? undo : null,
    origin: typeof origin === 'string' ? origin : null,
  }
}

export function registerFolderWriteRoutes(app: FastifyInstance, options: FolderWriteRouteOptions): void {
  app.post('/api/v1/folders', { preHandler: options.requireUser }, async (request, reply) => {
    const body = objectBody(request.body)
    const input: FolderCreateInput = {
      name: folderName(body.name),
      projectId: integer(body.projectId ?? body.project_id, 'projectId', true),
      workspaceDirectoryId: integer(body.workspaceDirectoryId ?? body.workspace_directory_id, 'workspaceDirectoryId', true),
      parentId: integer(body.parentId ?? body.parent_id, 'parentId', true),
    }
    return reply.code(201).send(await options.operations.create(
      options.ownerIdFromRequest(request), input, metadata(request),
    ))
  })

  app.patch<{ Params: { fid: string } }>('/api/v1/folders/:fid', { preHandler: options.requireUser }, async (request) => {
    const folderId = pathInteger(request.params.fid)
    const body = objectBody(request.body)
    const version = integer(body.version, 'version', false)!
    return options.operations.rename(
      options.ownerIdFromRequest(request), folderId,
      { name: folderName(body.name), version }, metadata(request),
    )
  })

  app.patch<{ Params: { fid: string } }>('/api/v1/folders/:fid/parent', { preHandler: options.requireUser }, async (request) => {
    const folderId = pathInteger(request.params.fid)
    const body = objectBody(request.body)
    const field = (camel: string, snake: string) => Object.hasOwn(body, camel) ? camel : snake
    const projectKey = field('projectId', 'project_id')
    const workspaceKey = field('workspaceDirectoryId', 'workspace_directory_id')
    const input: FolderMoveInput = {
      parentId: integer(body.parentId ?? body.parent_id, 'parentId', true),
      version: integer(body.version, 'version', false)!,
      projectId: integer(body[projectKey], 'projectId', true),
      projectSet: Object.hasOwn(body, 'projectId') || Object.hasOwn(body, 'project_id'),
      workspaceDirectoryId: integer(body[workspaceKey], 'workspaceDirectoryId', true),
      workspaceDirectorySet: Object.hasOwn(body, 'workspaceDirectoryId') || Object.hasOwn(body, 'workspace_directory_id'),
    }
    return options.operations.move(
      options.ownerIdFromRequest(request), folderId, input, metadata(request),
    )
  })
}
