import { withPostgresTransaction } from '@gugu/database/postgres/transaction'

export class UserNotFoundError extends Error {
  constructor() {
    super('无法撤销会话：用户不存在')
    this.name = 'UserNotFoundError'
  }
}

/** 在事务提交后返回新的会话安全版本。 */
export async function revokeUserSessions(
  pool: Parameters<typeof withPostgresTransaction>[0],
  userId: string,
): Promise<number> {
  return withPostgresTransaction(pool, async (client) => {
    const result = await client.query<{ security_version: number }>(
      `UPDATE users
       SET security_version = COALESCE(security_version, 0) + 1
       WHERE id = $1
       RETURNING security_version`,
      [userId],
    )
    const version = result.rows[0]?.security_version
    if (version === undefined) throw new UserNotFoundError()
    return version
  })
}
