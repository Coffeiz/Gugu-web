import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { WriteRequestMetadata } from '../../app.js'
import { writeRequestMetadata } from '../../http/request.js'
import { parseFileId } from './file-id.js'

export interface FileUpdateInput {
  version: number
  displayName?: string | null
  ext?: string | null
  stageName?: string | null
  folderId?: number | null
  projectId?: number | null
  workspaceDirectoryId?: number | null
  folderSet: boolean
  projectSet: boolean
  workspaceDirectorySet: boolean
}

export interface FileUpdateOperations {
  update(ownerId: string, fileId: number, input: FileUpdateInput, metadata: WriteRequestMetadata): Promise<unknown>
}

export interface FileUpdateRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileUpdateOperations
}

function parseBody(value: unknown): FileUpdateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('invalid_request', '文件更新参数无效')
  const body = value as Record<string, unknown>
  const nullableText = (field: string, max: number): string | null | undefined => {
    const entry = body[field]
    if (entry === undefined || entry === null) return entry
    if (typeof entry !== 'string' || entry.length > max) throw new CoreError('invalid_request', `${field} 无效`)
    return entry
  }
  const nullableId = (field: string): number | null | undefined => {
    const entry = body[field]
    if (entry === undefined || entry === null) return entry
    if (!Number.isSafeInteger(entry) || Number(entry) < 1) throw new CoreError('invalid_request', `${field} 无效`)
    return Number(entry)
  }
  const version = body.version
  if (!Number.isSafeInteger(version) || Number(version) < 1) throw new CoreError('invalid_request', '文件版本无效')
  const ext = nullableText('ext', 10)
  if (ext != null && !/^[A-Za-z0-9_-]{1,10}$/.test(ext)) throw new CoreError('invalid_request', '后缀格式无效')
  return {
    version: Number(version), displayName: nullableText('displayName', 300), ext, stageName: nullableText('stageName', 100),
    folderId: nullableId('folderId'), projectId: nullableId('projectId'), workspaceDirectoryId: nullableId('workspaceDirectoryId'),
    folderSet: Object.hasOwn(body, 'folderId'), projectSet: Object.hasOwn(body, 'projectId'),
    workspaceDirectorySet: Object.hasOwn(body, 'workspaceDirectoryId'),
  }
}

export function registerFileUpdateRoutes(app: FastifyInstance, options: FileUpdateRouteOptions): void {
  app.patch<{ Params: { fid: string } }>('/api/v1/files/:fid', { preHandler: options.requireUser }, async (request) =>
    options.operations.update(options.ownerIdFromRequest(request), parseFileId(request.params.fid), parseBody(request.body), writeRequestMetadata(request, { limitHeaders: true })))
}
