import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { SystemLogRow } from '@gugu/core/admin/system-logs'

export interface SystemLogOptions {
  requireAdmin: preHandlerHookHandler
  list(limit: number, level: string | null): Promise<{ items: SystemLogRow[] }>
}

export function registerSystemLogRoutes(app: FastifyInstance, options: SystemLogOptions): void {
  app.get('/api/v1/admin/system-logs', { preHandler: options.requireAdmin }, async (request, reply) => {
    const { limit = '200', level } = request.query as Record<string, unknown>
    if (typeof limit !== 'string' || !/^[+-]?\d+$/.test(limit.trim()) || !Number.isSafeInteger(Number(limit)) || (level !== undefined && typeof level !== 'string'))
      return reply.code(422).send({ detail: '系统日志查询参数无效' })
    return options.list(Number(limit), typeof level === 'string' ? level : null)
  })
}
