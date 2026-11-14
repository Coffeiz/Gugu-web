import type { FastifyInstance, FastifyReply } from 'fastify'
import type { UserFromRequest } from '../../../app.js'
import { parsePythonInteger, writeRequestMetadata } from '../../../http/request.js'
import { MindCanvasItemMutationError } from '../application/mind-canvas-item-mutations.js'
import type { MindCanvasItemResponse } from '../mind-canvas-read.js'

type ItemWriteMetadata = ReturnType<typeof writeRequestMetadata> & { mutationId: string | null }

export interface MindCanvasItemMutationOptions {
  add(ownerId: string, canvasId: number, input: unknown, metadata: ItemWriteMetadata): Promise<MindCanvasItemResponse>
  update(ownerId: string, canvasId: number, itemId: number, input: unknown, metadata: ItemWriteMetadata): Promise<MindCanvasItemResponse>
  bringToFront(ownerId: string, canvasId: number, itemId: number, input: unknown, metadata: ItemWriteMetadata): Promise<MindCanvasItemResponse>
  remove(ownerId: string, canvasId: number, itemId: number, metadata: ItemWriteMetadata): Promise<void>
}

function metadata(request: Parameters<typeof writeRequestMetadata>[0]): ItemWriteMetadata {
  const mutationId = request.headers['x-mutation-id']
  return {
    ...writeRequestMetadata(request),
    mutationId: typeof mutationId === 'string' ? mutationId : null,
  }
}

function invalidParams(reply: FastifyReply, canvasId: unknown, itemId?: unknown) {
  if (typeof canvasId !== 'number') return reply.code(422).send({ detail: '画布标识无效' })
  if (itemId !== undefined && typeof itemId !== 'number') return reply.code(422).send({ detail: '画布贴纸标识无效' })
  return null
}

function sendMutationError(reply: { code(statusCode: number): { send(payload: unknown): unknown } }, error: unknown) {
  if (error instanceof MindCanvasItemMutationError)
    return reply.code(error.statusCode).send({ detail: error.message })
  throw error
}

export function registerMindCanvasItemMutationRoutes(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  options: MindCanvasItemMutationOptions,
): void {
  app.post<{ Params: { canvasId: string } }>('/api/v1/mind/canvases/:canvasId/items', async (request, reply) => {
    const canvasId = parsePythonInteger(request.params.canvasId)
    const invalid = invalidParams(reply, canvasId)
    if (invalid) return invalid
    try {
      const item = await options.add(
        userFromRequest(request).requestContext.data.ownerId,
        canvasId as number,
        request.body,
        metadata(request),
      )
      return reply.code(201).send(item)
    } catch (error) {
      return sendMutationError(reply, error)
    }
  })

  app.patch<{ Params: { canvasId: string; itemId: string } }>(
    '/api/v1/mind/canvases/:canvasId/items/:itemId',
    async (request, reply) => {
      const canvasId = parsePythonInteger(request.params.canvasId)
      const itemId = parsePythonInteger(request.params.itemId)
      const invalid = invalidParams(reply, canvasId, itemId)
      if (invalid) return invalid
      try {
        return await options.update(
          userFromRequest(request).requestContext.data.ownerId,
          canvasId as number,
          itemId as number,
          request.body,
          metadata(request),
        )
      } catch (error) {
        return sendMutationError(reply, error)
      }
    },
  )

  app.post<{ Params: { canvasId: string; itemId: string } }>(
    '/api/v1/mind/canvases/:canvasId/items/:itemId/bring-to-front',
    async (request, reply) => {
      const canvasId = parsePythonInteger(request.params.canvasId)
      const itemId = parsePythonInteger(request.params.itemId)
      const invalid = invalidParams(reply, canvasId, itemId)
      if (invalid) return invalid
      try {
        return await options.bringToFront(
          userFromRequest(request).requestContext.data.ownerId,
          canvasId as number,
          itemId as number,
          request.body,
          metadata(request),
        )
      } catch (error) {
        return sendMutationError(reply, error)
      }
    },
  )

  app.delete<{ Params: { canvasId: string; itemId: string } }>(
    '/api/v1/mind/canvases/:canvasId/items/:itemId',
    async (request, reply) => {
      const canvasId = parsePythonInteger(request.params.canvasId)
      const itemId = parsePythonInteger(request.params.itemId)
      const invalid = invalidParams(reply, canvasId, itemId)
      if (invalid) return invalid
      try {
        await options.remove(
          userFromRequest(request).requestContext.data.ownerId,
          canvasId as number,
          itemId as number,
          metadata(request),
        )
        return reply.code(204).send()
      } catch (error) {
        return sendMutationError(reply, error)
      }
    },
  )
}
