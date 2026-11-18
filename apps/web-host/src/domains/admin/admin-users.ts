import type { Pool, PoolClient } from 'pg'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { withPostgresTransaction } from '../../adapters/postgres-transaction.js'
import { adminHttpError } from './errors.js'
import { toUtcIsoWithOffset } from '../../shared/date-time.js'

export interface AdminManagedUserStatus {
  id: string
  username: string
  account_status: string
  is_active: boolean
  suspended_until: Date | string | null
}

export interface AdminUserStatusStore {
  suspend(userId: string, durationSeconds: number, reason: string, now: Date): Promise<AdminManagedUserStatus | null>
  unsuspend(userId: string, now: Date): Promise<AdminManagedUserStatus | null>
}

export interface AdminUserStatusRouteOptions {
  requireAdmin: preHandlerHookHandler
  store: AdminUserStatusStore
  /** 必须在状态事务提交后发布；异常会按 Python events helper 语义忽略。 */
  publishAuthStateChanged: (userId: string) => Promise<unknown>
  /** 与 Python write_log 对齐，必须实际写入审计记录。 */
  writeAuditLog: (adminUsername: string, action: 'user', description: string, request: FastifyRequest) => Promise<void>
  adminUsername?: (request: FastifyRequest) => string
  now?: () => Date
}

function utcIso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return toUtcIsoWithOffset(value)
}

function createStatusRoutesOptions(options: AdminUserStatusRouteOptions) {
  return { preHandler: options.requireAdmin }
}

function adminUsername(options: AdminUserStatusRouteOptions, request: FastifyRequest): string {
  return options.adminUsername?.(request) ?? 'admin'
}

async function publishAfterCommit(options: AdminUserStatusRouteOptions, userId: string): Promise<void> {
  try {
    await options.publishAuthStateChanged(userId)
  } catch {
    // Python 的 publish_auth_state_changed 捕获 Redis 异常；已提交的 security_version 仍然有效。
  }
}

export function registerAdminUserStatusRoutes(app: FastifyInstance, options: AdminUserStatusRouteOptions): void {
  app.post<{
    Params: { user_id: string }
    Body: { duration_seconds?: number; reason?: string; confirm?: boolean }
  }>(
    '/api/v1/admin/users/:user_id/suspend',
    {
      ...createStatusRoutesOptions(options),
      schema: {
        params: {
          type: 'object', required: ['user_id'],
          properties: { user_id: { type: 'string' } },
        },
        body: {
          type: 'object',
          properties: {
            duration_seconds: { type: 'integer', minimum: 60, maximum: 2_592_000, default: 1_800 },
            reason: { type: 'string', minLength: 1, maxLength: 200, default: 'repeated_ownership_denied' },
            confirm: { type: 'boolean', default: false },
          },
        },
      },
    },
    async (request) => {
      const body = request.body ?? {}
      if (body.confirm !== true) throw adminHttpError(400, '冻结操作需要确认')
      const durationSeconds = body.duration_seconds ?? 1_800
      const reason = body.reason ?? 'repeated_ownership_denied'
      const now = options.now?.() ?? new Date()
      const user = await options.store.suspend(request.params.user_id, durationSeconds, reason, now)
      if (!user) throw adminHttpError(404, '用户不存在')

      await publishAfterCommit(options, user.id)
      await options.writeAuditLog(adminUsername(options, request), 'user', `冻结用户 ${user.username}`, request)
      return {
        id: request.params.user_id,
        account_status: user.account_status,
        is_active: user.is_active,
        suspended_until: utcIso(user.suspended_until),
      }
    },
  )

  app.post<{ Params: { user_id: string } }>(
    '/api/v1/admin/users/:user_id/unsuspend',
    {
      ...createStatusRoutesOptions(options),
      schema: {
        params: {
          type: 'object', required: ['user_id'],
          properties: { user_id: { type: 'string' } },
        },
      },
    },
    async (request) => {
      const now = options.now?.() ?? new Date()
      const user = await options.store.unsuspend(request.params.user_id, now)
      if (!user) throw adminHttpError(404, '用户不存在')

      await publishAfterCommit(options, user.id)
      await options.writeAuditLog(adminUsername(options, request), 'user', `解封用户 ${user.username}`, request)
      return { id: request.params.user_id, account_status: user.account_status, is_active: user.is_active }
    },
  )
}

type PgClient = PoolClient

async function transitionUserStatus<T extends AdminManagedUserStatus>(
  client: PgClient,
  sql: string,
  values: unknown[],
): Promise<T | null> {
  const current = await client.query('SELECT id FROM users WHERE id = $1::uuid FOR UPDATE', [values[0]])
  if (current.rows.length === 0) return null
  const result = await client.query(sql, values)
  return (result.rows[0] as T | undefined) ?? null
}

async function inStatusTransaction<T>(
  pool: Pick<Pool, 'connect'>,
  operation: (client: PgClient) => Promise<T>,
): Promise<T> {
  return withPostgresTransaction(pool, operation)
}

export function createPostgresAdminUserStatusStore(pool: Pick<Pool, 'connect'>): AdminUserStatusStore {
  return {
    suspend: (userId, durationSeconds, reason, now) => inStatusTransaction(pool, (client) => transitionUserStatus(
      client,
      `UPDATE users
       SET account_status = 'suspended', is_active = FALSE,
           suspended_until = $2::timestamptz + ($3::double precision * interval '1 second'),
           suspended_reason = $4, security_version = COALESCE(security_version, 0) + 1
       WHERE id = $1::uuid
       RETURNING id, username, account_status, is_active, suspended_until`,
      [userId, now, durationSeconds, Array.from(reason).slice(0, 200).join('')],
    )),
    unsuspend: (userId) => inStatusTransaction(pool, (client) => transitionUserStatus(
      client,
      `UPDATE users
       SET account_status = 'active', is_active = TRUE, suspended_until = NULL,
           suspended_reason = NULL, security_version = COALESCE(security_version, 0) + 1
       WHERE id = $1::uuid
       RETURNING id, username, account_status, is_active, suspended_until`,
      [userId],
    )),
  }
}
