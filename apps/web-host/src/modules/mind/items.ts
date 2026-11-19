import type { FastifyInstance, FastifyReply } from 'fastify'
import type { UserFromRequest, WriteRequestMetadata } from '../../app.js'
import { parsePythonInteger, writeRequestMetadata } from '../../http/request.js'
import { MindCanvasItemMutationError, MindCanvasNoteMutationError, MindRefNodeCreateError } from '@gugu/core/mind'
import type { MindCanvasItemResponse } from './canvas.js'
import type { MindNoteReadResponse } from './notes.js'

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

function noteMetadata(request: Parameters<typeof writeRequestMetadata>[0]): NoteWriteMetadata {
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
        noteMetadata(request),
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
        noteMetadata(request),
      )
    } catch (error) {
      if (error instanceof MindCanvasNoteMutationError)
        return reply.code(error.statusCode).send({ detail: error.message })
      throw error
    }
  })
}

type RefNodeWriteMetadata = ReturnType<typeof writeRequestMetadata> & { mutationId: string | null }

export interface MindRefNodeCreateOptions {
  create(ownerId: string, input: unknown, metadata: RefNodeWriteMetadata): Promise<MindNoteReadResponse>
}

function referenceMetadata(request: Parameters<typeof writeRequestMetadata>[0]): RefNodeWriteMetadata {
  const mutationId = request.headers['x-mutation-id']
  return {
    ...writeRequestMetadata(request),
    mutationId: typeof mutationId === 'string' ? mutationId : null,
  }
}

function sendCreateError(reply: { code(statusCode: number): { send(payload: unknown): unknown } }, error: unknown) {
  if (error instanceof MindRefNodeCreateError)
    return reply.code(error.statusCode).send({ detail: error.message })
  throw error
}

export function registerMindRefNodeCreateRoute(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  options: MindRefNodeCreateOptions,
): void {
  app.post('/api/v1/mind/nodes/ref', async (request, reply) => {
    try {
      const node = await options.create(
        userFromRequest(request).requestContext.data.ownerId,
        request.body,
        referenceMetadata(request),
      )
      return reply.code(201).send(node)
    } catch (error) {
      return sendCreateError(reply, error)
    }
  })
}
