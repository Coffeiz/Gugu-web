import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { WriteRequestMetadata } from '../../app.js'
import { writeRequestMetadata } from '../../http/request.js'
import { parseFileId } from './file-id.js'

export interface FileContentOperations {
  update(ownerId: string, fileId: number, content: string, version: number, metadata: WriteRequestMetadata): Promise<unknown>
}

export interface FileContentRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileContentOperations
}

export function registerFileContentRoutes(app: FastifyInstance, options: FileContentRouteOptions): void {
  app.put<{ Params: { fid: string }; Body: { content?: unknown; version?: unknown } }>(
    '/api/v1/files/:fid/content', { preHandler: options.requireUser, bodyLimit: 8 * 1024 * 1024 }, async (request) => {
      const { content, version } = request.body ?? {}
      if (typeof content !== 'string' || !Number.isSafeInteger(version) || Number(version) < 1)
        throw new CoreError('invalid_request', '文件内容或版本无效')
      return options.operations.update(
        options.ownerIdFromRequest(request), parseFileId(request.params.fid), content, Number(version), writeRequestMetadata(request, { limitHeaders: true }),
      )
    },
  )
}
