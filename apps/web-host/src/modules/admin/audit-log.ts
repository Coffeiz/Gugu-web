import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { createAdminAuditLogReader } from '@gugu/core/admin-audit-log'

export interface AdminAuditLogOptions {
  requireAdmin: preHandlerHookHandler
  read: ReturnType<typeof createAdminAuditLogReader>
}

export function registerAdminAuditLogRoute(app: FastifyInstance, options: AdminAuditLogOptions): void {
  app.get<{ Querystring: { limit?: number } }>('/api/v1/admin/audit-log', {
    preHandler: options.requireAdmin,
    schema: { querystring: { type: 'object', properties: { limit: { type: 'integer', default: 200 } } } },
  }, request => options.read(request.query.limit))
}
