import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

export function registerEmailRecipientCountRoute(app: FastifyInstance, options: {
  requireAdmin: preHandlerHookHandler
  read(): Promise<{count:number;locale_counts:Record<string,number>}>
}): void {
  app.get('/api/v1/admin/email/recipient-count', {preHandler:options.requireAdmin}, ()=>options.read())
}
