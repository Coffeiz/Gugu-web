import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { TerminalListItem } from '@gugu/core/terminals/list'

export interface TerminalDetailOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  read(ownerId: string, terminalId: string): Promise<TerminalListItem>
}

export function registerTerminalDetailRoute(app: FastifyInstance, options: TerminalDetailOptions): void {
  app.get<{ Params: { terminal_id: string } }>('/api/v1/terminals/:terminal_id', { preHandler: options.requireUser }, request =>
    options.read(options.ownerIdFromRequest(request), request.params.terminal_id))
}
