import type { FastifyInstance } from 'fastify'
import type { UserFromRequest } from '../../app.js'

export class UndoError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) { super(message) }
}
export interface UndoOperations {
  preview(ownerId: string, contextId: string): Promise<unknown>
  apply(ownerId: string, contextId: string, operationId: string, mode: 'undo' | 'redo'): Promise<unknown>
}

export function registerUndoRoutes(app: FastifyInstance, userFromRequest: UserFromRequest, operations: UndoOperations): void {
  app.get<{ Querystring: { context_id?: string } }>('/api/v1/undo/preview', async (request, reply) => {
    if (typeof request.query.context_id !== 'string') return reply.code(422).send({ detail: 'context_id 无效' })
    return operations.preview(userFromRequest(request).requestContext.data.ownerId, request.query.context_id)
  })
  for (const [path, mode] of [['/api/v1/undo', 'undo'], ['/api/v1/undo/redo', 'redo']] as const) {
    app.post(path, async (request, reply) => {
      const body = request.body as { operation_id?: unknown, context_id?: unknown } | null
      if (!body || typeof body.operation_id !== 'string' || typeof body.context_id !== 'string') return reply.code(422).send({ detail: '撤销请求无效' })
      try { return await operations.apply(userFromRequest(request).requestContext.data.ownerId, body.context_id, body.operation_id, mode) }
      catch (error) { if (error instanceof UndoError) return reply.code(error.statusCode).send({ detail: { code: error.code, message: error.message } }); throw error }
    })
  }
}
