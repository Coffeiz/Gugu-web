import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { TerminalListResult } from '@gugu/core/terminals/list'

export interface TerminalListOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  read(ownerId: string): Promise<TerminalListResult>
}

/** Terminal DTO, owner and access policy are supplied by the authenticated Host adapter. */
export function registerTerminalListRoute(app: FastifyInstance, options: TerminalListOptions): void {
  app.get('/api/v1/terminals', { preHandler: options.requireUser }, request =>
    options.read(options.ownerIdFromRequest(request)))
}
