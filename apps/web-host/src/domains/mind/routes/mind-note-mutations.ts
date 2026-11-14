import type { FastifyInstance } from 'fastify'
import type { UserFromRequest, WriteRequestMetadata } from '../../../app.js'
import { parsePythonInteger, writeRequestMetadata } from '../../../http/request.js'
import { MindNoteMutationError } from '../application/mind-note-mutations.js'
import type { MindNoteReadResponse } from '../mind-notes-read.js'

export interface MindNoteMutationOptions {
  update(
    ownerId: string,
    noteId: number,
    input: unknown,
    metadata: WriteRequestMetadata & { mutationId?: string | null },
  ): Promise<MindNoteReadResponse>
  delete(ownerId: string, noteId: number, metadata: WriteRequestMetadata & { mutationId?: string | null }): Promise<void>
}

export function registerMindNoteMutationRoutes(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  options: MindNoteMutationOptions,
): void {
  app.patch<{ Params: { noteId: string } }>('/api/v1/mind/notes/:noteId', async (request, reply) => {
    const id = parsePythonInteger(request.params.noteId) ?? null
    if (id === null) return reply.code(422).send({ detail: '便签标识无效' })
    const ownerId = userFromRequest(request).requestContext.data.ownerId
    try {
      const mutationId = request.headers['x-mutation-id']
      return await options.update(ownerId, id, request.body, {
        ...writeRequestMetadata(request),
        mutationId: typeof mutationId === 'string' ? mutationId : null,
      })
    } catch (error) {
      if (error instanceof MindNoteMutationError)
        return reply.code(error.statusCode).send({ detail: error.message })
      throw error
    }
  })

  app.delete<{ Params: { noteId: string } }>('/api/v1/mind/notes/:noteId', async (request, reply) => {
    const id = parsePythonInteger(request.params.noteId) ?? null
    if (id === null) return reply.code(422).send({ detail: '便签标识无效' })
    const ownerId = userFromRequest(request).requestContext.data.ownerId
    try {
      const mutationId = request.headers['x-mutation-id']
      await options.delete(ownerId, id, {
        ...writeRequestMetadata(request),
        mutationId: typeof mutationId === 'string' ? mutationId : null,
      })
      return reply.code(204).send()
    } catch (error) {
      if (error instanceof MindNoteMutationError)
        return reply.code(error.statusCode).send({ detail: error.message })
      throw error
    }
  })
}
