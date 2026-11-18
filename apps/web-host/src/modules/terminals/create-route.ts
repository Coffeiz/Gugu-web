import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { CoreError } from '@gugu/core'
import { z } from 'zod'
import type { TerminalListItem } from '@gugu/core/terminals/list'

const bodySchema = z.object({
  name: z.string().min(1).max(200).default('终端'),
  sessionId: z.number().int().positive().nullable().optional(),
  workspaceId: z.number().int().positive().nullable().optional(),
  mode: z.enum(['agent-events', 'interactive-pty']).default('interactive-pty'),
})

export interface TerminalCreateRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  create(ownerId: string, input: {
    name: string
    sessionId: number | null
    workspaceId: number | null
    mode: 'agent-events' | 'interactive-pty'
    origin: string | null
  }): Promise<TerminalListItem>
}

function sendError(reply: { code(status: number): { send(body: unknown): unknown } }, error: unknown) {
  if (error instanceof CoreError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 422
    return reply.code(status).send({ detail: error.message })
  }
  const status = Number((error as { statusCode?: unknown })?.statusCode)
  if (Number.isInteger(status) && status >= 400 && status < 600)
    return reply.code(status).send({ detail: (error as Error).message })
  throw error
}

/** Create a terminal through the Core transaction and publish only after commit. */
export function registerTerminalCreateRoute(app: FastifyInstance, options: TerminalCreateRouteOptions): void {
  app.post('/api/v1/terminals', { preHandler: options.requireUser }, async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(422).send({ detail: '终端参数无效' })
    try {
      const origin = typeof request.headers['x-client-id'] === 'string' ? request.headers['x-client-id'] : null
      return reply.code(201).send(await options.create(options.ownerIdFromRequest(request), {
        ...parsed.data,
        sessionId: parsed.data.sessionId ?? null,
        workspaceId: parsed.data.workspaceId ?? null,
        origin,
      }))
    } catch (error) { return sendError(reply, error) }
  })
}
