import type { ProfileUpdateStore, ProfileUpdatePatch, ProfileUpdateTransaction } from './profile-store.js'
import { withPostgresTransaction } from '@gugu/database/postgres/transaction'

interface ProfileRow {
  readonly timezone: string | null
  readonly hashed_password: string
  readonly security_version: number | null
}

/** 在同一事务内锁定并更新用户资料。 */
export function createPostgresProfileUpdateStore(pool: Parameters<typeof withPostgresTransaction>[0]): ProfileUpdateStore {
  return {
    transaction<T>(work: (transaction: ProfileUpdateTransaction) => Promise<T>): Promise<T> {
      return withPostgresTransaction(pool, async (client) => work({
        async loadForUpdate(ownerId) {
          const result = await client.query<ProfileRow>(
            'SELECT timezone, hashed_password, security_version FROM users WHERE id = $1 FOR UPDATE',
            [ownerId],
          )
          const row = result.rows[0]
          return row ? {
            timezone: row.timezone,
            hashedPassword: row.hashed_password,
            securityVersion: row.security_version,
          } : null
        },
        async update(ownerId, patch: ProfileUpdatePatch) {
          const values: unknown[] = [ownerId]
          const assignments: string[] = []
          if (patch.displayName !== undefined) {
            values.push(patch.displayName)
            assignments.push(`display_name = $${values.length}`)
          }
          if (patch.timezone !== undefined) {
            values.push(patch.timezone)
            assignments.push(`timezone = $${values.length}`)
          }
          if (patch.emailSubscribed !== undefined) {
            values.push(patch.emailSubscribed)
            assignments.push(`email_subscribed = $${values.length}`)
          }
          if (patch.hashedPassword !== undefined) {
            values.push(patch.hashedPassword)
            assignments.push(`hashed_password = $${values.length}`)
          }
          if (patch.incrementSecurityVersion) assignments.push('security_version = COALESCE(security_version, 0) + 1')
          const result = await client.query<{ security_version: number | null }>(
            `UPDATE users SET ${assignments.join(', ')} WHERE id = $1 RETURNING security_version`,
            values,
          )
          const row = result.rows[0]
          return row ? { securityVersion: row.security_version } : null
        },
      }))
    },
  }
}
