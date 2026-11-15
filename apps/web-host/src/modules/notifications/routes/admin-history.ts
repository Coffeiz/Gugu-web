import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { AdminNotificationHistoryRow } from '@gugu/core/notifications/admin-history'

export interface NotificationAdminHistoryOptions {
  requireAdmin: preHandlerHookHandler
  history(limit: number): Promise<AdminNotificationHistoryRow[]>
  deleteRecord(id: number): Promise<{ ok: true }>
}

/** HTTP 参数和管理员身份留在 Host；通知范围和删除语义由 Core 执行。 */
export function registerNotificationAdminHistoryRoutes(app: FastifyInstance, options: NotificationAdminHistoryOptions): void {
  app.get('/api/v1/admin/notifications/history', { preHandler: options.requireAdmin }, async (request, reply) => {
    const { limit = '50' } = request.query as Record<string, unknown>
    if (typeof limit !== 'string' || !/^[+-]?\d+$/.test(limit.trim()))
      return reply.code(422).send({ detail: 'limit 必须是整数' })
    const value = BigInt(limit.trim())
    return options.history(Number(value < 1n ? 1n : value > 100n ? 100n : value))
  })
  app.delete('/api/v1/admin/notifications/history/:nid', { preHandler: options.requireAdmin }, async (request, reply) => {
    const { nid } = request.params as { nid: string }
    if (!/^[+-]?\d+$/.test(nid.trim()) || !Number.isSafeInteger(Number(nid)))
      return reply.code(422).send({ detail: 'nid 必须是整数' })
    return options.deleteRecord(Number(nid))
  })
}
