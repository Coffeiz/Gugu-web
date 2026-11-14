import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Pool } from 'pg'
import {
  createPostgresAgentToolEventDetails,
  registerAgentToolEventDetailsRoute,
} from './agent-tool-event-details.js'

export interface AgentSessionToolEventDetailsRouteOptions {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  pool: Pick<Pool, 'query'>
}

export function registerAgentSessionToolEventDetailsRoute(
  app: FastifyInstance,
  options: AgentSessionToolEventDetailsRouteOptions,
): void {
  registerAgentToolEventDetailsRoute(app, {
    requireUser: options.requireUser,
    userIdFromRequest: options.userIdFromRequest,
    readDetails: createPostgresAgentToolEventDetails(options.pool),
  })
}
