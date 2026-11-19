import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export interface FileBatchDownloadOperations {
  build(ownerId: string, fileIds: number[], folderIds: number[]): Promise<Uint8Array>
  buildFolder?(ownerId: string, folderId: number): Promise<{ bytes: Uint8Array; folderName: string } | null>
}

export interface FileBatchDownloadRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileBatchDownloadOperations
}

function idList(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.some((id) => !Number.isSafeInteger(id)))
    throw new CoreError('invalid_request', `${field} 无效`)
  return value as number[]
}

export function registerFileBatchDownloadRoutes(
  app: FastifyInstance,
  options: FileBatchDownloadRouteOptions,
): void {
  app.post('/api/v1/files/batch-download', { preHandler: options.requireUser }, async (request, reply) => {
    const body = request.body
    if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body)))
      throw new CoreError('invalid_request', '批量下载参数无效')
    const record = (body ?? {}) as Record<string, unknown>
    const archive = await options.operations.build(
      options.ownerIdFromRequest(request),
      idList(record.ids ?? [], 'ids'),
      idList(record.folderIds ?? record.folder_ids ?? [], 'folderIds'),
    )
    return reply
      .type('application/zip')
      .header('Content-Disposition', "attachment; filename*=UTF-8''files.zip")
      .send(Buffer.from(archive))
  })
}
