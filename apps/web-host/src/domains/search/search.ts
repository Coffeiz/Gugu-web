import { parseGlobalSearchQuery } from '@gugu/core'
import type { GlobalSearchOperations } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export interface GlobalSearchRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: GlobalSearchOperations
}

export function registerGlobalSearchRoute(app: FastifyInstance, options: GlobalSearchRouteOptions): void {
  app.get('/api/v1/search', { preHandler: options.requireUser }, async (request) =>
    options.operations.search(
      options.ownerIdFromRequest(request),
      parseGlobalSearchQuery(request.query),
    ))
}
