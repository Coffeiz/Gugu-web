import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { WriteRequestMetadata } from '../../app.js'
import { writeRequestMetadata } from '../../http/request.js'

export interface FolderCopyInput {
  parentId: number | null
  projectId: number | null
  workspaceDirectoryId: number | null
}

export interface FolderCopyOperations {
  copy(ownerId: string, folderId: number, input: FolderCopyInput, metadata: WriteRequestMetadata): Promise<unknown>
}

export interface FolderCopyRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FolderCopyOperations
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CoreError('invalid_request', '复制参数无效')
  return body as Record<string, unknown>
}

function integer(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && /^[+-]?\d+(?:\.0+)?$/.test(value.trim())) value = Number(value.trim())
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new CoreError('invalid_request', `${field} 无效`)
  return value
}

function pathInteger(value: string): number {
  if (!/^[+-]?\d+$/.test(value.trim())) throw new CoreError('invalid_request', '文件夹 ID 无效')
  const parsed = Number(value.trim())
  if (!Number.isSafeInteger(parsed)) throw new CoreError('invalid_request', '文件夹 ID 无效')
  return parsed
}

export function registerFolderCopyRoute(app: FastifyInstance, options: FolderCopyRouteOptions): void {
  app.post<{ Params: { fid: string } }>('/api/v1/folders/:fid/copy', { preHandler: options.requireUser }, async (request, reply) => {
    const body = objectBody(request.body)
    const result = await options.operations.copy(options.ownerIdFromRequest(request), pathInteger(request.params.fid), {
      parentId: integer(body.parentId ?? body.parent_id, 'parentId'),
      projectId: integer(body.projectId ?? body.project_id, 'projectId'),
      workspaceDirectoryId: integer(body.workspaceDirectoryId ?? body.workspace_directory_id, 'workspaceDirectoryId'),
    }, writeRequestMetadata(request, { limitHeaders: true }))
    return reply.code(201).send(result)
  })
}
