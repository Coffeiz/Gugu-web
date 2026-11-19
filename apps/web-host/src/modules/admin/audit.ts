import type { FastifyInstance,preHandlerHookHandler } from 'fastify'

import { createHmac } from 'node:crypto'

import { adminHttpError } from './errors.js'

import { utc } from '@gugu/core/shared/timestamps'

import type { Kysely } from 'kysely'

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

interface SecurityEventDatabase {
  users: { id: string }
  security_events: {
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
    metadata_json: unknown
    occurred_at: Date | string
    expires_at: Date | string
  }
}

type SecurityEventRow = SecurityEventDatabase['security_events']
function securityEventTime(value: Date | string): string {
  return utc(value instanceof Date ? value.toISOString() : value).replace(' ', 'T')
}


/** 管理员全局安全事件读取；按 Python 窗口和字段边界投影，不返回事件元数据。 */
export function createAdminSecurityEventReader(
  db: Kysely<any>,
  fingerprintUserId: (userId: string) => string,
  now: () => Date = () => new Date(),
) {
  return async (filters: AdminSecurityEventFilters = {}) => {
    const sinceMinutes = filters.since_minutes ?? 1440
    const limit = filters.limit ?? 200
    if (!Number.isInteger(sinceMinutes) || sinceMinutes < 1 || sinceMinutes > 90 * 24 * 60
      || !Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new RangeError('安全事件查询范围无效')
    let query = db.selectFrom('security_events')
      .select([
        'id', 'user_id', 'event_type', 'resource_type', 'resource_fingerprint',
        'owner_fingerprint', 'client_fingerprint', 'ip_fingerprint', 'user_agent_fingerprint',
        'action', 'reason_code', 'occurred_at',
      ])
      .where('occurred_at', '>=', new Date(now().getTime() - sinceMinutes * 60_000).toISOString().replace(/Z$/, '+00:00'))
    if (filters.event_type) query = query.where('event_type', '=', filters.event_type.slice(0, 80))
    if (filters.action) query = query.where('action', '=', filters.action.slice(0, 32))
    if (filters.resource_type) query = query.where('resource_type', '=', filters.resource_type.slice(0, 120))
    if (filters.user_id) query = query.where('user_id', '=', filters.user_id)
    const rows = await query.orderBy('occurred_at', 'desc').limit(limit).execute() as SecurityEventRow[]
    const items = rows.map(row => ({
      id: Number(row.id),
      user_id: fingerprintUserId(String(row.user_id)),
      event_type: row.event_type,
      resource_type: row.resource_type,
      resource_fingerprint: row.resource_fingerprint,
      owner_fingerprint: row.owner_fingerprint,
      client_fingerprint: row.client_fingerprint,
      ip_fingerprint: row.ip_fingerprint,
      user_agent_fingerprint: row.user_agent_fingerprint,
      action: row.action,
      reason_code: row.reason_code,
      occurred_at: securityEventTime(row.occurred_at),
    }))
    return { items, total: items.length, since_minutes: sinceMinutes }
  }
}

/** 按 Python 行为先确认目标用户存在，再读取其有限数量的脱敏事件字段。 */
export function createAdminUserSecurityEventReader(db: Kysely<any>) {
  return async (userId: string, limit = 100) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new RangeError('安全事件条数无效')
    const user = await db.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst()
    if (!user) return null
    const rows = await db.selectFrom('security_events')
      .select([
        'id', 'event_type', 'resource_type', 'resource_fingerprint', 'owner_fingerprint',
        'client_fingerprint', 'ip_fingerprint', 'action', 'reason_code', 'occurred_at',
      ])
      .where('user_id', '=', userId)
      .orderBy('occurred_at', 'desc')
      .limit(limit)
      .execute() as SecurityEventRow[]
    return { items: rows.map(row => ({
      id: Number(row.id),
      event_type: row.event_type,
      resource_type: row.resource_type,
      resource_fingerprint: row.resource_fingerprint,
      owner_fingerprint: row.owner_fingerprint,
      client_fingerprint: row.client_fingerprint,
      ip_fingerprint: row.ip_fingerprint,
      action: row.action,
      reason_code: row.reason_code,
      occurred_at: securityEventTime(row.occurred_at),
    })) }
  }
}

export type AdminAuditLogQuery = (sql: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>

/** Web 管理员审计读取。调用方须先验证管理员身份；不向 DTO 透传存储扩展字段。 */
export function createAdminAuditLogReader(query: AdminAuditLogQuery) {
  return async (limit = 200) => {
    const { rows } = await query(
      'SELECT id, username, action, description, ip, created_at::text AS created_at FROM audit_logs ORDER BY created_at DESC LIMIT $1',
      [limit],
    )
    return { items: rows.map(row => ({
      id: row.id, username: row.username, action: row.action,
      description: row.description, ip: row.ip,
      created_at: utc(row.created_at).replace(' ', 'T'),
    })) }
  }
}
