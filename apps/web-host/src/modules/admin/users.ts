import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { adminHttpError } from '../../domains/admin/errors.js'

export interface AdminUsersOptions {
  requireAdmin: preHandlerHookHandler
  read: (search?: string) => Promise<{ items: Record<string, unknown>[]; total: number }>
}

export interface AdminUserRiskOptions {
  requireAdmin: preHandlerHookHandler
  read: (windowMinutes?: number) => Promise<{
    items: Record<string, unknown>[]
    total: number
    window_minutes: number
    policy_window_minutes: number
  }>
}

export function registerAdminUsersRoute(app: FastifyInstance, options: AdminUsersOptions): void {
  app.get<{ Querystring: { q?: string } }>(
    '/api/v1/admin/users',
    {
      preHandler: options.requireAdmin,
      schema: { querystring: { type: 'object', properties: { q: { type: 'string' } } } },
    },
    async request => {
      try {
        return await options.read(request.query.q)
      } catch {
        throw adminHttpError(500, '用户列表查询失败')
      }
    },
  )
}

export function registerAdminUserRiskRoute(app: FastifyInstance, options: AdminUserRiskOptions): void {
  app.get<{ Querystring: { window_minutes?: number } }>(
    '/api/v1/admin/users/risk',
    {
      preHandler: options.requireAdmin,
      schema: {
        querystring: {
          type: 'object',
          properties: { window_minutes: { type: 'integer', minimum: 1, maximum: 43_200, default: 1_440 } },
        },
      },
    },
    async request => {
      try {
        return await options.read(request.query.window_minutes ?? 1_440)
      } catch {
        throw adminHttpError(500, '风险用户查询失败')
      }
    },
  )
}
