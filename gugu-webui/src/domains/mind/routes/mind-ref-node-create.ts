import type { FastifyInstance, FastifyReply } from 'fastify'
import type { UserFromRequest } from '../../../app.js'
import { writeRequestMetadata } from '../../../http/request.js'
import { MindRefNodeCreateError } from '../application/mind-ref-node-create.js'
import type { MindNoteReadResponse } from '../mind-notes-read.js'

type RefNodeWriteMetadata = ReturnType<typeof writeRequestMetadata> & { mutationId: string | null }

export interface MindRefNodeCreateOptions {
  create(ownerId: string, input: unknown, metadata: RefNodeWriteMetadata): Promise<MindNoteReadResponse>
}

function metadata(request: Parameters<typeof writeRequestMetadata>[0]): RefNodeWriteMetadata {
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
        metadata(request),
      )
      return reply.code(201).send(node)
    } catch (error) {
      return sendCreateError(reply, error)
    }
  })
}
