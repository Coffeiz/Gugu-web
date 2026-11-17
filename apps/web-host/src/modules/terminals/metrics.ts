import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export interface TerminalMetricsOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  read(ownerId: string): Promise<{ total: number; running: number; outputChars: number; retentionDays: number; outputRetentionChars: number }>
}

/** 持久化计数仍受与 Python 终端页面相同的 Shell 页面授权保护。 */
export function registerTerminalMetricsRoute(app: FastifyInstance, options: TerminalMetricsOptions): void {
  app.get('/api/v1/terminals/metrics', { preHandler: options.requireUser }, request =>
    options.read(options.ownerIdFromRequest(request)))
}
