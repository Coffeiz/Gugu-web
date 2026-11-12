import type { Pool } from 'pg'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

export type AdminUserSecurityEventQuery = (sql: string, values: unknown[]) => Promise<Record<string, unknown>[]>
export interface AdminUserSecurityEventOptions {
  requireAdmin: preHandlerHookHandler
  query: AdminUserSecurityEventQuery
}

export function createPostgresAdminUserSecurityEventQuery(pool: Pick<Pool, 'query'>): AdminUserSecurityEventQuery {
  return async (sql, values) => (await pool.query(sql, values as never[])).rows as Record<string, unknown>[]
}

function isoUtc(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) throw new Error('invalid security event timestamp')
  return date.toISOString().replace(/Z$/, '+00:00')
}

function notFound(): Error & { statusCode: number } {
  return Object.assign(new Error('用户不存在'), { statusCode: 404 })
}

function safeFailure(): Error & { statusCode: number } {
  return Object.assign(new Error('用户安全事件查询失败'), { statusCode: 500 })
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
      let users: Record<string, unknown>[]
      try {
        users = await options.query('SELECT id FROM users WHERE id = $1::uuid LIMIT 1', [userId])
      } catch {
        throw safeFailure()
      }
      if (!users.length) throw notFound()
      try {
        const rows = await options.query(
          `SELECT id, event_type, resource_type, resource_fingerprint, owner_fingerprint,
                  client_fingerprint, ip_fingerprint, action, reason_code, occurred_at
           FROM security_events
           WHERE user_id = $1::uuid
           ORDER BY occurred_at DESC
           LIMIT $2`,
          [userId, limit],
        )
        return { items: rows.map((row) => ({
          id: Number(row.id),
          event_type: row.event_type,
          resource_type: row.resource_type,
          resource_fingerprint: row.resource_fingerprint,
          owner_fingerprint: row.owner_fingerprint,
          client_fingerprint: row.client_fingerprint,
          ip_fingerprint: row.ip_fingerprint,
          action: row.action,
          reason_code: row.reason_code,
          occurred_at: isoUtc(row.occurred_at),
        })) }
      } catch {
        throw safeFailure()
      }
    },
  )
}
