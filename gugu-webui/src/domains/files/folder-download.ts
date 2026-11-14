import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export interface FolderDownloadOperations {
  buildFolder(ownerId: string, folderId: number): Promise<{ bytes: Uint8Array; folderName: string } | null>
}

export interface FolderDownloadRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FolderDownloadOperations
}

function parseFolderId(value: string): number {
  if (!/^[+-]?\d+$/.test(value.trim())) throw new CoreError('invalid_request', '文件夹 ID 无效')
  const id = Number(value)
  if (!Number.isSafeInteger(id)) throw new CoreError('invalid_request', '文件夹 ID 无效')
  return id
}

export function registerFolderDownloadRoutes(app: FastifyInstance, options: FolderDownloadRouteOptions): void {
  app.get<{ Params: { fid: string } }>('/api/v1/folders/:fid/download', {
    preHandler: options.requireUser,
  }, async (request, reply) => {
    const result = await options.operations.buildFolder(
      options.ownerIdFromRequest(request), parseFolderId(request.params.fid),
    )
    if (!result) throw new CoreError('not_found', '文件夹不存在')
    const filename = encodeURIComponent(`${result.folderName}.zip`)
      .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    return reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
      .send(Buffer.from(result.bytes))
  })
}
