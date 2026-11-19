import { createPostgresAgentSessionLister, type AgentSessionListRuntime } from '@gugu/core/agent-sessions'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Pool } from 'pg'

export interface AgentSessionRouteOptions {
  /** Host authentication hook; it must reject before the identity accessor or store runs. */
  requireUser: preHandlerHookHandler
  /** Reads the authenticated RequestContext created by the Host, never request input. */
  userIdFromRequest(request: FastifyRequest): string
  list(ownerId: string): Promise<unknown[]>
}

export function registerAgentSessionRoute(app: FastifyInstance, options: AgentSessionRouteOptions): void {
  app.get('/api/v1/agent/sessions', { preHandler: options.requireUser }, async (request) =>
    options.list(options.userIdFromRequest(request)),
  )
}

export type AgentSessionRuntime = AgentSessionListRuntime

/** HTTP 身份与运行能力仍由 Host 提供；业务列表由 Core 处理。 */
export function createAgentSessionLister(pool: Pool, runtime: AgentSessionRuntime) {
  return createPostgresAgentSessionLister(pool, runtime)
}
