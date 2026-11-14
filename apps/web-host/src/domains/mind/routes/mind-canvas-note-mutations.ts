import type { FastifyInstance } from 'fastify'
import type { UserFromRequest, WriteRequestMetadata } from '../../../app.js'
import { parsePythonInteger, writeRequestMetadata } from '../../../http/request.js'
import { MindCanvasNoteMutationError } from '../application/mind-canvas-note-mutations.js'
import type { MindCanvasItemResponse } from '../mind-canvas-read.js'
import type { MindNoteReadResponse } from '../mind-notes-read.js'

type NoteWriteMetadata = WriteRequestMetadata & { mutationId: string | null }

export interface MindCanvasNoteMutationOptions {
  create(
    ownerId: string,
    canvasId: number,
    input: unknown,
    metadata: NoteWriteMetadata,
  ): Promise<MindCanvasItemResponse>
  update(
    ownerId: string,
    nodeId: number,
    input: unknown,
    metadata: NoteWriteMetadata,
  ): Promise<MindNoteReadResponse>
}

function metadata(request: Parameters<typeof writeRequestMetadata>[0]): NoteWriteMetadata {
  const mutationId = request.headers['x-mutation-id']
  return {
    ...writeRequestMetadata(request),
    mutationId: typeof mutationId === 'string' ? mutationId : null,
  }
}

export function registerMindCanvasNoteMutationRoutes(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  options: MindCanvasNoteMutationOptions,
): void {
  app.post<{ Params: { canvasId: string } }>('/api/v1/mind/canvases/:canvasId/notes', async (request, reply) => {
    const canvasId = parsePythonInteger(request.params.canvasId)
    if (typeof canvasId !== 'number') return reply.code(422).send({ detail: '画布标识无效' })
    try {
      const item = await options.create(
        userFromRequest(request).requestContext.data.ownerId,
        canvasId,
        request.body,
        metadata(request),
      )
      return reply.code(201).send(item)
    } catch (error) {
      if (error instanceof MindCanvasNoteMutationError)
        return reply.code(error.statusCode).send({ detail: error.message })
      throw error
    }
  })

  app.patch<{ Params: { nodeId: string } }>('/api/v1/mind/nodes/:nodeId', async (request, reply) => {
    const nodeId = parsePythonInteger(request.params.nodeId)
    if (typeof nodeId !== 'number') return reply.code(422).send({ detail: '画布便签标识无效' })
    try {
      return await options.update(
        userFromRequest(request).requestContext.data.ownerId,
        nodeId,
        request.body,
        metadata(request),
      )
    } catch (error) {
      if (error instanceof MindCanvasNoteMutationError)
        return reply.code(error.statusCode).send({ detail: error.message })
      throw error
    }
  })
}
