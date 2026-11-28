import { parseGlobalSearchQuery, type GlobalSearchOperations } from '@gugu/search'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export interface GlobalSearchRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: GlobalSearchOperations
}

export function registerGlobalSearchRoute(app: FastifyInstance, options: GlobalSearchRouteOptions): void {
  app.get('/api/v1/search', { preHandler: options.requireUser }, async (request, reply) => {
    const controller = new AbortController()
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort() }
    reply.raw.once('close', onClose)
    try {
      const query = parseGlobalSearchQuery(request.query)
      const types = query.types ?? options.operations.availableTypes
      return await options.operations.search(options.ownerIdFromRequest(request), { ...query, types }, { signal: controller.signal })
    } finally {
      reply.raw.off('close', onClose)
    }
  })
}
