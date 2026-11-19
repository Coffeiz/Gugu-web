import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export interface FileConflictInput {
  filename: string
  space: string
  projectId: number | null
  folderId: number | null
  workspaceDirectoryId: number | null
}

export interface FileConflictOperations {
  find(ownerId: string, items: FileConflictInput[]): Promise<unknown[]>
}

export interface FileConflictRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileConflictOperations
}

function nullableInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value)) throw new CoreError('invalid_request', `${field} 无效`)
  return Number(value)
}

function parseItem(value: unknown): FileConflictInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CoreError('invalid_request', '冲突探测参数无效')
  const item = value as Record<string, unknown>
  if (typeof item.filename !== 'string') throw new CoreError('invalid_request', '文件名无效')
  const space = item.space ?? 'personal'
  if (typeof space !== 'string') throw new CoreError('invalid_request', '文件空间无效')
  return {
    filename: item.filename,
    space,
    projectId: nullableInteger(item.projectId, 'projectId'),
    folderId: nullableInteger(item.folderId, 'folderId'),
    workspaceDirectoryId: nullableInteger(item.workspaceDirectoryId, 'workspaceDirectoryId'),
  }
}

export function registerFileConflictRoutes(app: FastifyInstance, options: FileConflictRouteOptions): void {
  app.post('/api/v1/files/check-conflicts', { preHandler: options.requireUser }, async (request) => {
    const body = request.body
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new CoreError('invalid_request', '冲突探测参数无效')
    const items = (body as Record<string, unknown>).items
    if (!Array.isArray(items)) throw new CoreError('invalid_request', '冲突探测列表无效')
    return options.operations.find(options.ownerIdFromRequest(request), items.map(parseItem))
  })
}
