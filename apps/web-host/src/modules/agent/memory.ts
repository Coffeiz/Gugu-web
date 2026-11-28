import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { createMemoryClearer } from '@gugu/core/agent/memory-clear'

export interface MemoryClearOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  clear: ReturnType<typeof createMemoryClearer>
}

export function registerMemoryClearRoute(app: FastifyInstance, options: MemoryClearOptions): void {
  app.delete('/api/v1/agent/memory', { preHandler: options.requireUser }, async (request, reply) => {
    await options.clear(options.ownerIdFromRequest(request))
    return reply.code(204).send()
  })
}
