import type { FastifyInstance } from 'fastify'
import type { UserFromRequest, WriteRequestMetadata } from '../../../app.js'
import { MindNoteCreateError } from '../application/mind-note-create.js'
import type { MindNoteReadResponse } from '../mind-notes-read.js'
import { writeRequestMetadata } from '../../../http/request.js'

export interface MindNoteCreateOptions {
  create(
    ownerId: string,
    input: unknown,
    metadata: WriteRequestMetadata & { mutationId?: string | null },
  ): Promise<MindNoteReadResponse>
}

export function registerMindNoteCreateRoute(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  options: MindNoteCreateOptions,
): void {
  app.post('/api/v1/mind/notes', async (request, reply) => {
    const ownerId = userFromRequest(request).requestContext.data.ownerId
    try {
      const mutationId = request.headers['x-mutation-id']
      const note = await options.create(ownerId, request.body, {
        ...writeRequestMetadata(request),
        mutationId: typeof mutationId === 'string' ? mutationId : null,
      })
      return reply.code(201).send(note)
    } catch (error) {
      if (error instanceof MindNoteCreateError)
        return reply.code(error.statusCode).send({ detail: error.message })
      throw error
    }
  })
}
