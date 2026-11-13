import type { Pool } from 'pg'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { createHmac } from 'node:crypto'

export type AdminSecurityEventQuery = (sql: string, values: unknown[]) => Promise<unknown[]>
export interface AdminSecurityEventOptions {
  requireAdmin: preHandlerHookHandler
  query: AdminSecurityEventQuery
  /** 与 Python security_fingerprint 相同的服务端 HMAC；原始 user_id 不向客户端返回。 */
  fingerprintUserId: (userId: string) => string
}

/** Generate Python security_fingerprint-compatible HMACs for returned user IDs. */
export function createSecurityEventFingerprint(secretKey: string): (userId: string) => string {
  return (userId) => createHmac('sha256', secretKey).update(userId, 'utf8').digest('hex')
}

type SecurityEventRecord = {
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
  occurred_at: Date | string
}

export function createPostgresAdminSecurityEventQuery(pool: Pick<Pool, 'query'>): AdminSecurityEventQuery {
  return async (sql, values) => {
    const result = await pool.query(sql, values as never[])
    return result.rows as SecurityEventRecord[]
  }
}

function safeFailure(): Error & { statusCode: number } {
  return Object.assign(new Error('安全事件查询失败'), { statusCode: 500 })
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
      const {
        event_type: eventType,
        action,
        resource_type: resourceType,
        user_id: userId,
        since_minutes: sinceMinutes = 1440,
        limit = 200,
      } = request.query
      const conditions = ['occurred_at >= $1']
      const values: unknown[] = [new Date(Date.now() - sinceMinutes * 60_000)]
      const addFilter = (column: string, value: string | undefined, maxLength: number) => {
        if (!value) return
        values.push(value.slice(0, maxLength))
        conditions.push(`${column} = $${values.length}`)
      }
      addFilter('event_type', eventType, 80)
      addFilter('action', action, 32)
      addFilter('resource_type', resourceType, 120)
      if (userId) {
        values.push(userId)
        conditions.push(`user_id = $${values.length}::uuid`)
      }
      values.push(limit)
      const sql = `SELECT id, user_id, event_type, resource_type, resource_fingerprint,
                          owner_fingerprint, client_fingerprint, ip_fingerprint,
                          user_agent_fingerprint, action, reason_code, occurred_at
                   FROM security_events
                   WHERE ${conditions.join(' AND ')}
                   ORDER BY occurred_at DESC LIMIT $${values.length}`
      try {
        const result = await options.query(sql, values)
        const items = result.map((unknownRow) => {
          const row = unknownRow as SecurityEventRecord
          return {
            id: row.id,
            // Python endpoint currently exposes the UUID here. Keep the field consumed by the UI,
            // but pseudonymize its value so the API never returns a stable raw account identifier.
            user_id: options.fingerprintUserId(String(row.user_id)),
            event_type: row.event_type,
            resource_type: row.resource_type,
            resource_fingerprint: row.resource_fingerprint,
            owner_fingerprint: row.owner_fingerprint,
            client_fingerprint: row.client_fingerprint,
            ip_fingerprint: row.ip_fingerprint,
            user_agent_fingerprint: row.user_agent_fingerprint,
            action: row.action,
            reason_code: row.reason_code,
            occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : new Date(row.occurred_at).toISOString(),
          }
        })
        return { items, total: items.length, since_minutes: sinceMinutes }
      } catch {
        throw safeFailure()
      }
    },
  )
}
