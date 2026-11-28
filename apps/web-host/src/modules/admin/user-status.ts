/** 平台管理员已经授权的账户状态操作，不提供租户范围。 */
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

export function createAdminUserStatusOperations(options: {
  store: AdminUserStatusStore
  publishAuthStateChanged(userId: string): Promise<unknown>
  writeAuditLog(description: string): Promise<void>
}) {
  async function finish(user: AdminManagedUserStatus | null, action: '冻结' | '解封') {
    if (!user) return null
    try { await options.publishAuthStateChanged(user.id) } catch {
      // 已提交的账户状态和安全版本不能因通知失败而回滚。
    }
    await options.writeAuditLog(`${action}用户 ${user.username}`)
    return user
  }
  return {
    async suspend(userId: string, durationSeconds: number, reason: string, now: Date) {
      return finish(await options.store.suspend(userId, durationSeconds, reason, now), '冻结')
    },
    async unsuspend(userId: string, now: Date) {
      return finish(await options.store.unsuspend(userId, now), '解封')
    },
  }
}

export interface AdminStatusQuery {
  (sql: string, values: unknown[]): Promise<{ rows: readonly Record<string, unknown>[] }>
}

/** 事务由可信 Host 装配；锁定和变更必须在同一 PostgreSQL 连接上执行。 */
export type AdminStatusTransaction = <T>(work: (query: AdminStatusQuery) => Promise<T>) => Promise<T>

export function createPostgresAdminUserStatusStore(transaction: AdminStatusTransaction): AdminUserStatusStore {
  async function transition(sql: string, values: unknown[]): Promise<AdminManagedUserStatus | null> {
    return transaction(async query => {
      const current = await query('SELECT id FROM users WHERE id = $1::uuid FOR UPDATE', [values[0]])
      if (current.rows.length === 0) return null
      const result = await query(sql, values)
      return (result.rows[0] as unknown as AdminManagedUserStatus | undefined) ?? null
    })
  }
  return {
    suspend: (userId, durationSeconds, reason, now) => transition(
      `UPDATE users
       SET account_status = 'suspended', is_active = FALSE,
           suspended_until = $2::timestamptz + ($3::double precision * interval '1 second'),
           suspended_reason = $4, security_version = COALESCE(security_version, 0) + 1
       WHERE id = $1::uuid
       RETURNING id, username, account_status, is_active, suspended_until`,
      [userId, now, durationSeconds, Array.from(reason).slice(0, 200).join('')],
    ),
    unsuspend: (userId) => transition(
      `UPDATE users
       SET account_status = 'active', is_active = TRUE, suspended_until = NULL,
           suspended_reason = NULL, security_version = COALESCE(security_version, 0) + 1
       WHERE id = $1::uuid
       RETURNING id, username, account_status, is_active, suspended_until`,
      [userId],
    ),
  }
}
