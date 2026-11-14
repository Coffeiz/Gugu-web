import type { FastifyInstance, FastifyReply } from 'fastify'
import type { UserFromRequest } from '../../../app.js'
import { parsePythonInteger, writeRequestMetadata } from '../../../http/request.js'
import { MindCanvasRelationMutationError } from '../application/mind-canvas-relation-mutations.js'
import type { MindRelationResponse } from '../mind-canvas-read.js'

type RelationWriteMetadata = ReturnType<typeof writeRequestMetadata> & { mutationId: string | null }

export interface MindCanvasRelationMutationOptions {
  create(ownerId: string, input: unknown, metadata: RelationWriteMetadata): Promise<MindRelationResponse>
  delete(ownerId: string, canvasId: number, relationId: number, metadata: RelationWriteMetadata): Promise<unknown>
  deleteGlobal?(ownerId: string, relationId: number, metadata: RelationWriteMetadata): Promise<unknown>
}

function metadata(request: Parameters<typeof writeRequestMetadata>[0]): RelationWriteMetadata {
  const mutationId = request.headers['x-mutation-id']
  return {
    ...writeRequestMetadata(request),
    mutationId: typeof mutationId === 'string' ? mutationId : null,
  }
}

function invalidParams(reply: FastifyReply, canvasId: unknown, relationId?: unknown) {
  if (typeof canvasId !== 'number') return reply.code(422).send({ detail: '画布标识无效' })
  if (relationId !== undefined && typeof relationId !== 'number') return reply.code(422).send({ detail: '画布关联标识无效' })
  return null
}

function sendMutationError(reply: { code(statusCode: number): { send(payload: unknown): unknown } }, error: unknown) {
  if (error instanceof MindCanvasRelationMutationError)
    return reply.code(error.statusCode).send({ detail: error.message })
  throw error
}

export function registerMindCanvasRelationMutationRoutes(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  options: MindCanvasRelationMutationOptions,
): void {
  app.post('/api/v1/mind/relations', async (request, reply) => {
    try {
      const relation = await options.create(
        userFromRequest(request).requestContext.data.ownerId,
        request.body,
        metadata(request),
      )
      return reply.code(201).send(relation)
    } catch (error) {
      return sendMutationError(reply, error)
    }
  })

  app.delete<{ Params: { canvasId: string; relationId: string } }>(
    '/api/v1/mind/canvases/:canvasId/relations/:relationId',
    async (request, reply) => {
      const canvasId = parsePythonInteger(request.params.canvasId)
      const relationId = parsePythonInteger(request.params.relationId)
      const invalid = invalidParams(reply, canvasId, relationId)
      if (invalid) return invalid
      try {
        await options.delete(
          userFromRequest(request).requestContext.data.ownerId,
          canvasId as number,
          relationId as number,
          metadata(request),
        )
        return reply.code(204).send()
      } catch (error) {
        return sendMutationError(reply, error)
      }
    },
  )

  if (options.deleteGlobal) app.delete<{ Params: { relationId: string } }>(
    '/api/v1/mind/relations/:relationId',
    async (request, reply) => {
      const relationId = parsePythonInteger(request.params.relationId)
      if (typeof relationId !== 'number')
        return reply.code(422).send({ detail: '关联标识无效' })
      try {
        await options.deleteGlobal!(
          userFromRequest(request).requestContext.data.ownerId,
          relationId,
          metadata(request),
        )
        return reply.code(204).send()
      } catch (error) {
        return sendMutationError(reply, error)
      }
    },
  )
}
