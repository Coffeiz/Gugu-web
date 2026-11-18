import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { CoreError } from '@gugu/core'
import type { TerminalListItem } from '@gugu/core/terminals/list'

export interface TerminalReopenRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  reopen(ownerId: string, terminalId: string, origin: string | null): Promise<TerminalListItem>
}

function sendError(reply: { code(status: number): { send(body: unknown): unknown } }, error: unknown) {
  if (error instanceof CoreError) return reply.code(error.code === 'not_found' ? 404 : 422).send({ detail: error.message })
  const status = Number((error as { statusCode?: unknown })?.statusCode)
  if (Number.isInteger(status) && status >= 400 && status < 600) return reply.code(status).send({ detail: (error as Error).message })
  throw error
}

/** Reopen a terminal through the owner-scoped Core transaction. */
export function registerTerminalReopenRoute(app: FastifyInstance, options: TerminalReopenRouteOptions): void {
  app.post<{ Params: { terminal_id: string } }>('/api/v1/terminals/:terminal_id/reopen', { preHandler: options.requireUser }, async (request, reply) => {
    try {
      const origin = typeof request.headers['x-client-id'] === 'string' ? request.headers['x-client-id'] : null
      return await options.reopen(options.ownerIdFromRequest(request), request.params.terminal_id, origin)
    } catch (error) { return sendError(reply, error) }
  })
}
