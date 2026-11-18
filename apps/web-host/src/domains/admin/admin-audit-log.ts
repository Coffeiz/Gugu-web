import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { createHmac } from 'node:crypto'
import { adminHttpError } from './errors.js'

export interface AdminSecurityEventFilters {
  event_type?: string
  action?: string
  resource_type?: string
  user_id?: string
  since_minutes?: number
  limit?: number
}
export interface AdminSecurityEventItem {
  id: number
  user_id: string
  event_type: string
  resource_type: string
  resource_fingerprint: string
  owner_fingerprint: string | null
  client_fingerprint: string | null
  ip_fingerprint: string | null
  user_agent_fingerprint: string | null
  action: string
  reason_code: string
  occurred_at: string
}
export interface AdminSecurityEventOptions {
  requireAdmin: preHandlerHookHandler
  read: (filters: AdminSecurityEventFilters) => Promise<{
    items: AdminSecurityEventItem[]
    total: number
    since_minutes: number
  }>
}

/** Generate Python security_fingerprint-compatible HMACs for returned user IDs. */
export function createSecurityEventFingerprint(secretKey: string): (userId: string) => string {
  return (userId) => createHmac('sha256', secretKey).update(userId, 'utf8').digest('hex')
}

export function registerAdminSecurityEventRoutes(app: FastifyInstance, options: AdminSecurityEventOptions): void {
  app.get<{ Querystring: {
    event_type?: string
    action?: string
    resource_type?: string
    user_id?: string
    since_minutes?: number
    limit?: number
  } }>(
    '/api/v1/admin/audit-log/security-events',
    {
      preHandler: options.requireAdmin,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            event_type: { type: 'string' },
            action: { type: 'string' },
            resource_type: { type: 'string' },
            user_id: { type: 'string', format: 'uuid' },
            since_minutes: { type: 'integer', minimum: 1, maximum: 129600, default: 1440 },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
          },
        },
      },
    },
    async (request) => {
      try {
        return await options.read(request.query)
      } catch {
        throw adminHttpError(500, '安全事件查询失败')
      }
    },
  )
}
