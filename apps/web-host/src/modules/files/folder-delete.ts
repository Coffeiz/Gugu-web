import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { PoolClient } from 'pg'

export interface FolderDeleteReceipt {
  operationId: string
  fingerprint: string
  method: 'agent.file.delete_folder'
}

export interface FolderDeleteMetadata {
  undoContextId: string | null
  origin: string | null
}

export interface FolderDeleteOperations {
  remove(ownerId: string, folderId: number, metadata: FolderDeleteMetadata,
    operation?: { receipt: FolderDeleteReceipt; signal?: AbortSignal; authorize(client: Pick<PoolClient, 'query'>): Promise<void> }): Promise<unknown>
}

export interface FolderDeleteRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FolderDeleteOperations
}

function folderId(value: string): number {
  if (!/^[+-]?\d+$/.test(value)) throw new CoreError('invalid_request', '文件夹 ID 无效')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new CoreError('invalid_request', '文件夹 ID 无效')
  return parsed
}

function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name]
  return typeof value === 'string' ? value.trim().slice(0, 128) || null : null
}

/** Folder lifecycle HTTP adapter; authorization and subtree semantics remain in Core/operations. */
export function registerFolderDeleteRoute(app: FastifyInstance, options: FolderDeleteRouteOptions): void {
  app.delete<{ Params: { fid: string } }>('/api/v1/folders/:fid', {
    preHandler: options.requireUser,
  }, async (request, reply) => {
    await options.operations.remove(options.ownerIdFromRequest(request), folderId(request.params.fid), {
      undoContextId: header(request, 'x-undo-context-id'),
      origin: header(request, 'x-client-id'),
    })
    return reply.code(204).send()
  })
}
