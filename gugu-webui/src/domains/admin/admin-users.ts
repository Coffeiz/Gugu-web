import type { Pool, PoolClient } from 'pg'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export type AdminUsersQuery = (sql: string, values: unknown[]) => Promise<Record<string, unknown>[]>

export interface AdminUsersOptions {
  requireAdmin: preHandlerHookHandler
  query: AdminUsersQuery
  storageBackend: 'local' | 'oss'
  now?: () => Date
}

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

type UserRow = Record<string, unknown> & {
  id: string
  username: string | null
  email: string | null
  display_name: string | null
  is_active: boolean
  account_status: string | null
  suspended_until: Date | string | null
  is_developer: boolean | null
  created_at: Date | string | null
  token_limit_6h: number | string | null
  token_limit_weekly: number | string | null
  storage_limit_bytes: number | string | null
  search_limit_daily: number | string | null
}

export function createPostgresAdminUsersQuery(pool: Pick<Pool, 'query'>): AdminUsersQuery {
  return async (sql, values) => (await pool.query(sql, values as never[])).rows as Record<string, unknown>[]
}

function utcIso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) throw new Error('invalid user timestamp')
  return date.toISOString().replace(/Z$/, '+00:00')
}

function asNumber(value: unknown): number {
  return Number(value ?? 0)
}

function mondayUtc(now: Date): Date {
  const result = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  result.setUTCDate(result.getUTCDate() - ((result.getUTCDay() + 6) % 7))
  return result
}

function sixHourWindowUtc(now: Date): Date {
  return new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    Math.floor(now.getUTCHours() / 6) * 6,
  ))
}

function safeFailure(): Error & { statusCode: number } {
  return Object.assign(new Error('用户列表查询失败'), { statusCode: 500 })
}

const USER_QUERY = `SELECT id, username, email, display_name, is_active, account_status,
                           suspended_until, is_developer, created_at, token_limit_6h,
                           token_limit_weekly, storage_limit_bytes, search_limit_daily
                    FROM users
                    ORDER BY created_at DESC`

const USAGE_QUERY = `SELECT user_id, COALESCE(SUM(tokens_in + tokens_out), 0)::bigint AS tokens
                     FROM agent_usage
                     WHERE created_at >= $1 AND is_byok IS FALSE
                     GROUP BY user_id`

const FILE_USAGE_QUERY = `SELECT user_id, COALESCE(SUM(size_bytes), 0)::bigint AS storage_used
                          FROM files
                          GROUP BY user_id`

const LOCAL_LIBRARY_USAGE_QUERY = `SELECT user_id, used_bytes AS storage_used
                                   FROM storage_quota_ledgers
                                   WHERE category = 'file_library'`

export function registerAdminUsersRoute(app: FastifyInstance, options: AdminUsersOptions): void {
  app.get<{ Querystring: { q?: string } }>(
    '/api/v1/admin/users',
    {
      preHandler: options.requireAdmin,
      schema: {
        querystring: {
          type: 'object',
          properties: { q: { type: 'string' } },
        },
      },
    },
    async (request) => {
      try {
        // The optional search is applied after ordering, matching Python's list-then-filter flow.
        const users = await options.query(USER_QUERY, []) as UserRow[]
        const now = options.now?.() ?? new Date()
        const [weekRows, sixHourRows, fileRows, libraryRows] = await Promise.all([
          options.query(USAGE_QUERY, [mondayUtc(now)]),
          options.query(USAGE_QUERY, [sixHourWindowUtc(now)]),
          options.query(FILE_USAGE_QUERY, []),
          options.storageBackend === 'local'
            ? options.query(LOCAL_LIBRARY_USAGE_QUERY, [])
            : Promise.resolve([]),
        ])

        const q = request.query.q
        const needle = q ? q.toLowerCase() : null
        const visibleUsers = needle
          ? users.filter((user) => (user.username ?? '').toLowerCase().includes(needle)
            || (user.email ?? '').toLowerCase().includes(needle))
          : users
        const toUsageMap = (rows: Record<string, unknown>[]) => new Map(
          rows.map((row) => [String(row.user_id), asNumber(row.tokens)]),
        )
        const weekUsage = toUsageMap(weekRows)
        const sixHourUsage = toUsageMap(sixHourRows)
        const storageUsage = new Map(fileRows.map((row) => [String(row.user_id), asNumber(row.storage_used)]))
        if (options.storageBackend === 'local') {
          // Local 的 file_library 账本已经含所有可写持久根；按 Python update 语义覆盖文件记录值。
          for (const row of libraryRows) storageUsage.set(String(row.user_id), asNumber(row.storage_used))
        }

        return {
          items: visibleUsers.map((user) => {
            const id = String(user.id)
            return {
              id,
              username: user.username,
              email: user.email,
              display_name: user.display_name,
              is_active: user.is_active,
              account_status: user.account_status ?? 'active',
              suspended_until: utcIso(user.suspended_until),
              is_developer: Boolean(user.is_developer ?? false),
              created_at: utcIso(user.created_at),
              tokens_week: weekUsage.get(id) ?? 0,
              tokens_6h: sixHourUsage.get(id) ?? 0,
              storage_used: storageUsage.get(id) ?? 0,
              token_limit_6h: user.token_limit_6h,
              token_limit_weekly: user.token_limit_weekly,
              storage_limit_bytes: user.storage_limit_bytes,
              search_limit_daily: user.search_limit_daily,
            }
          }),
          total: visibleUsers.length,
        }
      } catch {
        throw safeFailure()
      }
    },
  )
}

function statusError(statusCode: number, detail: string): Error & { statusCode: number } {
  return Object.assign(new Error(detail), { statusCode })
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
      if (body.confirm !== true) throw statusError(400, '冻结操作需要确认')
      const durationSeconds = body.duration_seconds ?? 1_800
      const reason = body.reason ?? 'repeated_ownership_denied'
      const now = options.now?.() ?? new Date()
      const user = await options.store.suspend(request.params.user_id, durationSeconds, reason, now)
      if (!user) throw statusError(404, '用户不存在')

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
      if (!user) throw statusError(404, '用户不存在')

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
  if (current.rows.length === 0) {
    await client.query('ROLLBACK')
    return null
  }
  const result = await client.query(sql, values)
  await client.query('COMMIT')
  return (result.rows[0] as T | undefined) ?? null
}

async function inStatusTransaction<T>(
  pool: Pick<Pool, 'connect'>,
  operation: (client: PgClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    return await operation(client)
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* 保留原始失败 */ }
    throw error
  } finally {
    client.release()
  }
}

export function createPostgresAdminUserStatusStore(pool: Pick<Pool, 'connect'>): AdminUserStatusStore {
  return {
    suspend: (userId, durationSeconds, reason, now) => inStatusTransaction(pool, (client) => transitionUserStatus(
      client,
      `UPDATE users
       SET account_status = 'suspended', is_active = FALSE,
           suspended_until = $2::timestamptz + ($3::double precision * interval '1 second'),
           suspended_reason = $4, security_version = COALESCE(security_version, 0) + 1, updated_at = $2
       WHERE id = $1::uuid
       RETURNING id, username, account_status, is_active, suspended_until`,
      [userId, now, durationSeconds, Array.from(reason).slice(0, 200).join('')],
    )),
    unsuspend: (userId, now) => inStatusTransaction(pool, (client) => transitionUserStatus(
      client,
      `UPDATE users
       SET account_status = 'active', is_active = TRUE, suspended_until = NULL,
           suspended_reason = NULL, security_version = COALESCE(security_version, 0) + 1, updated_at = $2
       WHERE id = $1::uuid
       RETURNING id, username, account_status, is_active, suspended_until`,
      [userId, now],
    )),
  }
}
