import type { FastifyInstance, FastifyReply } from 'fastify'
import { CoreError } from '@gugu/core'

const INTERNAL_ERROR_DETAIL = '服务器内部错误，请稍后重试'

function coreErrorStatus(error: CoreError): number | null {
  switch (error.code) {
    case 'invalid_request': return 422
    case 'not_found': return 404
    case 'conflict': return 409
    default: return null
  }
}

function sendDetail(reply: FastifyReply, statusCode: number, detail: string) {
  return reply.code(statusCode).send({ detail })
}

/** 将 Fastify 错误响应统一为既有 FastAPI 的 detail 格式，并隐藏内部异常。 */
export function installHttpErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof CoreError) {
      const statusCode = coreErrorStatus(error)
      return sendDetail(reply, statusCode ?? 500, statusCode === null ? INTERNAL_ERROR_DETAIL : error.message)
    }

    if (!(error instanceof Error)) return sendDetail(reply, 500, INTERNAL_ERROR_DETAIL)
    const fastifyError = error as Error & { statusCode?: unknown; validation?: unknown }
    if (Array.isArray(fastifyError.validation)) return sendDetail(reply, 422, error.message)

    const statusCode = typeof fastifyError.statusCode === 'number'
      ? fastifyError.statusCode
      : 500
    if (statusCode >= 400 && statusCode < 500)
      return sendDetail(reply, statusCode, error.message)

    return sendDetail(reply, 500, INTERNAL_ERROR_DETAIL)
  })
}
