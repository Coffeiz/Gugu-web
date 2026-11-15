import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { CoreError } from '@gugu/core'
import { XlsxPreviewError } from '@gugu/core/files/xlsx-preview'

export interface XlsxPreviewOperations {
  preview(ownerId: string, fileId: number): Promise<{ version: number; sheets: unknown[] }>
  image(ownerId: string, fileId: number, imageId: number): Promise<{ content: Uint8Array; mime: string }>
}

export interface XlsxPreviewRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: XlsxPreviewOperations
}

function pathInteger(value: string, label: string): number {
  const normalized = value.trim()
  if (!/^[+-]?\d+$/.test(normalized)) throw new CoreError('invalid_request', `${label} 无效`)
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed)) throw new CoreError('invalid_request', `${label} 无效`)
  return parsed
}

function sendPreviewError(error: unknown, reply: { code(statusCode: number): { send(payload: unknown): unknown } }): unknown {
  if (error instanceof XlsxPreviewError)
    return reply.code(error.statusCode).send({ detail: error.detail })
  throw error
}

export function registerXlsxPreviewRoutes(app: FastifyInstance, options: XlsxPreviewRouteOptions): void {
  app.get<{ Params: { fid: string } }>('/api/v1/files/:fid/xlsx-preview', { preHandler: options.requireUser }, async (request, reply) => {
    try {
      return await options.operations.preview(options.ownerIdFromRequest(request), pathInteger(request.params.fid, '文件 ID'))
    } catch (error) { return sendPreviewError(error, reply) }
  })

  app.get<{ Params: { fid: string; image_id: string } }>('/api/v1/files/:fid/xlsx-preview-image/:image_id', { preHandler: options.requireUser }, async (request, reply) => {
    try {
      const result = await options.operations.image(
        options.ownerIdFromRequest(request),
        pathInteger(request.params.fid, '文件 ID'),
        pathInteger(request.params.image_id, '图片 ID'),
      )
      return reply.type(result.mime).header('Cache-Control', 'private, max-age=86400').send(Buffer.from(result.content))
    } catch (error) { return sendPreviewError(error, reply) }
  })
}
