import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { adminHttpError } from './errors.js'

export interface AdminUserSecurityEventItem {
  id: number
  event_type: string
  resource_type: string
  resource_fingerprint: string
  owner_fingerprint: string | null
  client_fingerprint: string | null
  ip_fingerprint: string | null
  action: string
  reason_code: string
  occurred_at: string
}
export interface AdminUserSecurityEventOptions {
  requireAdmin: preHandlerHookHandler
  read: (userId: string, limit: number) => Promise<{ items: AdminUserSecurityEventItem[] } | null>
}

export function registerAdminUserSecurityEventRoute(app: FastifyInstance, options: AdminUserSecurityEventOptions): void {
  app.get<{ Params: { user_id: string }; Querystring: { limit?: number } }>(
    '/api/v1/admin/users/:user_id/security-events',
    {
      preHandler: options.requireAdmin,
      schema: {
        params: {
          type: 'object', required: ['user_id'],
          properties: { user_id: { type: 'string', format: 'uuid' } },
        },
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
        },
      },
    },
    async (request) => {
      const userId = request.params.user_id
      const limit = request.query.limit ?? 100
      let result: { items: AdminUserSecurityEventItem[] } | null
      try {
        result = await options.read(userId, limit)
      } catch {
        throw adminHttpError(500, '用户安全事件查询失败')
      }
      if (!result) throw adminHttpError(404, '用户不存在')
      return result
    },
  )
}
