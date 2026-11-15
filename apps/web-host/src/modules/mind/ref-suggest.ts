import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { createMindReferenceSuggester } from '@gugu/core/mind'
import { parsePythonInteger } from '../../http/request.js'

export type MindReferenceSuggestOperations = ReturnType<typeof createMindReferenceSuggester>

export function registerMindReferenceSuggestRoute(app: FastifyInstance, options: {
  ownerId(request: FastifyRequest): string
  operations: MindReferenceSuggestOperations
}): void {
  app.get('/api/v1/mind/ref-suggest', async (request, reply) => {
    const raw = request.query && typeof request.query === 'object' && !Array.isArray(request.query)
      ? request.query as Record<string, unknown>
      : {}
    if (raw.q !== undefined && typeof raw.q !== 'string')
      return reply.code(422).send({ detail: 'q 必须是字符串' })
    const rawLimit = raw.limit === undefined ? '6' : raw.limit
    const limit = parsePythonInteger(rawLimit)
    if (typeof limit !== 'number' || limit < 1 || limit > 20)
      return reply.code(422).send({ detail: 'limit 必须是 1 到 20 之间的整数' })
    return options.operations.suggest(options.ownerId(request), typeof raw.q === 'string' ? raw.q : '', limit)
  })
}
