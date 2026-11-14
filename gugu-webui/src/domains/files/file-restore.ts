import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { parseFileId } from './file-id.js'

export interface FileRestoreOperations {
  restore(ownerId: string, fileId: number, origin?: string | null): Promise<void>
  restoreBatch?(ownerId: string, fileIds: number[], origin?: string | null): Promise<void>
  restoreFolder?(ownerId: string, folderId: number, origin?: string | null): Promise<unknown>
}

export interface FileRestoreRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileRestoreOperations
}

export function registerFileRestoreRoutes(app: FastifyInstance, options: FileRestoreRouteOptions): void {
  app.post<{ Params: { fid: string } }>('/api/v1/trash/:fid/restore', {
    preHandler: options.requireUser,
  }, async (request, reply) => {
    const rawClientId = request.headers['x-client-id']
    const clientId = typeof rawClientId === 'string' ? rawClientId.trim().slice(0, 128) || null : null
    await options.operations.restore(options.ownerIdFromRequest(request), parseFileId(request.params.fid), clientId)
    return reply.code(204).send()
  })
}
