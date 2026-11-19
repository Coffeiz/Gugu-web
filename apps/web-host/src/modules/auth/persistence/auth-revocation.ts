import type { Pool } from 'pg'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'

export class UserNotFoundError extends Error {
  constructor() {
    super('无法撤销会话：用户不存在')
    this.name = 'UserNotFoundError'
  }
}

/**
 * Atomically advances the user's JWT security version.
 * Resolves only after PostgreSQL has committed the revocation.
 */
export async function revokeUserSessions(
  pool: Pick<Pool, 'connect'>,
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
