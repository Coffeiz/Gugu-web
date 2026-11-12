import type { Pool } from 'pg'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

export type AdminUserRiskQuery = (sql: string, values: unknown[]) => Promise<Record<string, unknown>[]>
export interface AdminUserRiskOptions {
  requireAdmin: preHandlerHookHandler
  query: AdminUserRiskQuery
  now?: () => Date
}

export function createPostgresAdminUserRiskQuery(pool: Pick<Pool, 'query'>): AdminUserRiskQuery {
  return async (sql, values) => (await pool.query(sql, values as never[])).rows as Record<string, unknown>[]
}

function isoUtc(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) throw new Error('invalid timestamp')
  return date.toISOString().replace(/Z$/, '+00:00')
}

function safeFailure(): Error & { statusCode: number } {
  return Object.assign(new Error('风险用户查询失败'), { statusCode: 500 })
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
    async (request) => {
      const now = options.now?.() ?? new Date()
      const windowMinutes = request.query.window_minutes ?? 1_440
      const visibleCutoff = new Date(now.getTime() - windowMinutes * 60_000)
      const policyCutoff = new Date(now.getTime() - 5 * 60_000)
      const sql = `WITH visible_events AS (
                     SELECT user_id, COUNT(id)::bigint AS event_count, MAX(occurred_at) AS last_event_at
                     FROM security_events WHERE occurred_at >= $1 GROUP BY user_id
                   ), recent_events AS (
                     SELECT user_id, COUNT(id)::bigint AS event_count
                     FROM security_events WHERE occurred_at >= $2 GROUP BY user_id
                   )
                   SELECT u.id, u.username, u.email, u.display_name,
                          u.account_status, u.is_active, u.suspended_until,
                          u.suspended_reason, u.security_version,
                          COALESCE(recent_events.event_count, 0)::bigint AS recent_event_count,
                          COALESCE(visible_events.event_count, 0)::bigint AS visible_event_count,
                          visible_events.last_event_at, u.created_at
                   FROM users u
                   LEFT JOIN visible_events ON visible_events.user_id = u.id
                   LEFT JOIN recent_events ON recent_events.user_id = u.id
                   WHERE u.account_status <> 'active' OR visible_events.user_id IS NOT NULL
                   ORDER BY u.updated_at DESC`
      try {
        const rows = await options.query(sql, [visibleCutoff.toISOString(), policyCutoff.toISOString()])
        const items = rows.map((row) => {
          const recentEventCount = Number(row.recent_event_count ?? 0)
          const visibleEventCount = Number(row.visible_event_count ?? 0)
          return {
            id: String(row.id),
            username: row.username,
            email: row.email,
            display_name: row.display_name,
            account_status: row.account_status ?? 'active',
            is_active: row.is_active,
            suspended_until: isoUtc(row.suspended_until),
            suspended_reason: row.suspended_reason,
            security_version: Number(row.security_version ?? 0),
            recent_event_count: recentEventCount,
            visible_event_count: visibleEventCount,
            last_event_at: isoUtc(row.last_event_at),
            risk_action: recentEventCount >= 10 ? 'suspended' : recentEventCount >= 5 ? 'throttled' : 'logged',
          }
        })
        return { items, total: items.length, window_minutes: windowMinutes, policy_window_minutes: 5 }
      } catch {
        throw safeFailure()
      }
    },
  )
}
