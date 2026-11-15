import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

export function registerStorageLiveTotalsRoute(app: FastifyInstance, options: {
  requireAdmin: preHandlerHookHandler
  read(): Promise<{ categories: Record<string, { object_count: number; total_bytes: number }> }>
}): void {
  app.get('/api/v1/admin/ops/storage-live-totals', { preHandler: options.requireAdmin }, () => options.read())
}
