import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { CoreError } from '@gugu/core'
import type { TerminalListItem } from '@gugu/core/terminals/list'

export interface TerminalLifecycleRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  reset(ownerId: string, terminalId: string, origin: string | null): Promise<TerminalListItem>
  terminate(ownerId: string, terminalId: string, origin: string | null): Promise<TerminalListItem>
}

function sendError(reply: { code(status: number): { send(body: unknown): unknown } }, error: unknown) {
  if (error instanceof CoreError) return reply.code(error.code === 'not_found' ? 404 : 422).send({ detail: error.message })
  const status = Number((error as { statusCode?: unknown })?.statusCode)
  if (Number.isInteger(status) && status >= 400 && status < 600) return reply.code(status).send({ detail: (error as Error).message })
  throw error
}

export function registerTerminalLifecycleRoutes(app: FastifyInstance, options: TerminalLifecycleRouteOptions): void {
  const routes = [
    ['reset', options.reset],
    ['terminate', options.terminate],
  ] as const
  for (const [action, perform] of routes) {
    app.post<{ Params: { terminal_id: string } }>(`/api/v1/terminals/:terminal_id/${action}`, { preHandler: options.requireUser }, async (request, reply) => {
      try {
        const origin = typeof request.headers['x-client-id'] === 'string' ? request.headers['x-client-id'] : null
        return await perform(options.ownerIdFromRequest(request), request.params.terminal_id, origin)
      } catch (error) { return sendError(reply, error) }
    })
  }
}
