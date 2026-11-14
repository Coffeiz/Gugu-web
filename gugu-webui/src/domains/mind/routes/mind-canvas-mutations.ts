import type { FastifyInstance } from 'fastify'
import type { UserFromRequest, WriteRequestMetadata } from '../../../app.js'
import { parsePythonInteger, writeRequestMetadata } from '../../../http/request.js'
import { MindCanvasMutationError } from '../application/mind-canvas-mutations.js'
import type { MindCanvasResponse } from '../mind-canvas-read.js'

export interface MindCanvasMutationOptions {
  create(ownerId: string, input: unknown, metadata: WriteRequestMetadata): Promise<MindCanvasResponse>
  update(ownerId: string, canvasId: number, input: unknown, metadata: WriteRequestMetadata): Promise<MindCanvasResponse>
  delete?(ownerId: string, canvasId: number, metadata: WriteRequestMetadata): Promise<void>
}

export function registerMindCanvasMutationRoutes(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  options: MindCanvasMutationOptions,
): void {
  app.post('/api/v1/mind/canvases', async (request, reply) => {
    const ownerId = userFromRequest(request).requestContext.data.ownerId
    try {
      const canvas = await options.create(ownerId, request.body, writeRequestMetadata(request))
      return reply.code(201).send(canvas)
    } catch (error) {
      if (error instanceof MindCanvasMutationError)
        return reply.code(error.statusCode).send({ detail: error.message })
      throw error
    }
  })

  app.patch<{ Params: { canvasId: string } }>('/api/v1/mind/canvases/:canvasId', async (request, reply) => {
    const canvasId = parsePythonInteger(request.params.canvasId)
    if (typeof canvasId !== 'number')
      return reply.code(422).send({ detail: '画布标识无效' })
    const ownerId = userFromRequest(request).requestContext.data.ownerId
    try {
      return await options.update(ownerId, canvasId, request.body, writeRequestMetadata(request))
    } catch (error) {
      if (error instanceof MindCanvasMutationError)
        return reply.code(error.statusCode).send({ detail: error.message })
      throw error
    }
  })

  if (options.delete) app.delete<{ Params: { canvasId: string } }>('/api/v1/mind/canvases/:canvasId', async (request, reply) => {
    const canvasId = parsePythonInteger(request.params.canvasId)
    if (typeof canvasId !== 'number')
      return reply.code(422).send({ detail: '画布标识无效' })
    const ownerId = userFromRequest(request).requestContext.data.ownerId
    try {
      await options.delete!(ownerId, canvasId, writeRequestMetadata(request))
      return reply.code(204).send()
    } catch (error) {
      if (error instanceof MindCanvasMutationError)
        return reply.code(error.statusCode).send({ detail: error.message })
      throw error
    }
  })
}
