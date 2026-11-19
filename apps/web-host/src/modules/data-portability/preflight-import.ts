import { CoreError } from '@gugu/core'
import { dataImportMaxUploadBytes, DataImportPreflightError, DataImportUploadError } from '@gugu/core/data-portability/preflight-import'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { createDataImportPreflighter } from '@gugu/core/data-portability/preflight-import'

export interface DataImportPreflightRouteOptions {
  ownerIdFromRequest(request: FastifyRequest): string
  preflight: ReturnType<typeof createDataImportPreflighter>
}

export function registerDataImportPreflightRoute(app: FastifyInstance, options: DataImportPreflightRouteOptions): void {
  app.addContentTypeParser('*', (_request, payload, done) => done(null, payload))
  app.post('/api/v1/data-portability/imports/preflight', {
    bodyLimit: dataImportMaxUploadBytes,
    preHandler: async (request, reply) => {
      const contentType = (request.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/zip' && contentType !== 'application/octet-stream')
        return reply.code(415).send({ detail: '请选择 ZIP 格式的 Gugu 数据归档' })
      const rawLength = request.headers['content-length']
      if (rawLength !== undefined) {
        const length = Number(rawLength)
        if (!Number.isSafeInteger(length) || length < 0)
          return reply.code(400).send({ detail: '上传长度无效' })
        if (length > dataImportMaxUploadBytes)
          return reply.code(413).send({ detail: '上传归档超过大小限制' })
      }
    },
  }, async (request, reply) => {
    const ownerId = options.ownerIdFromRequest(request)
    const source = request.body as AsyncIterable<Uint8Array>
    try {
      if (!source || typeof source[Symbol.asyncIterator] !== 'function')
        return reply.code(400).send({ detail: '上传归档为空' })
      const { id, importToken, createdAt, expiresAt } = await options.preflight(ownerId, source)
      return reply.code(202).header('Cache-Control', 'no-store').send({
        id, status: 'queued', stage: 'queued', mode: 'preflight',
        progress_current: 0, progress_total: null, error_code: null, preview: null,
        created_at: createdAt.toISOString(), expires_at: expiresAt.toISOString(), rollback_expires_at: null,
        import_token: importToken,
      })
    } catch (error) {
      if (error instanceof DataImportUploadError || error instanceof DataImportPreflightError)
        return reply.code(error.statusCode).send({ detail: error.message })
      if (error instanceof CoreError) {
        const status = error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400
        return reply.code(status).send({ detail: error.message })
      }
      return reply.code(503).send({ detail: '上传归档暂时失败，请重试' })
    }
  })
}
