import type { Pool } from 'pg'
import type { PublicUserRecord } from './auth.js'

interface UserRow {
  id: string
  username: string
  display_name: string | null
  email: string
  is_active: boolean
  account_status: string | null
  security_version: number | null
  avatar: string | null
  created_at: string | null
  timezone: string | null
  email_subscribed: boolean | null
}

export function createUserRepository(pool: Pool): {
  lookupUser: (userId: string) => Promise<PublicUserRecord | null>
  markUserActive: (userId: string) => Promise<void>
} {
  return {
    async lookupUser(userId) {
      const { rows } = await pool.query<UserRow>(
        `SELECT id::text, username, display_name, email, is_active, account_status,
                security_version, avatar,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') ||
                  CASE WHEN date_trunc('second', created_at) = created_at
                       THEN '' ELSE '.' || to_char(created_at AT TIME ZONE 'UTC', 'US') END || '+00:00'
                  AS created_at,
                timezone, email_subscribed
         FROM users WHERE id = $1 LIMIT 1`,
        [userId],
      )
      const row = rows[0]
      if (!row) return null

      const { rows: bots } = await pool.query<{ platform: string }>(
        `SELECT DISTINCT platform FROM user_bots
         WHERE user_id = $1 AND enabled IS TRUE
           AND platform = ANY($2::text[])
         ORDER BY platform`,
        [userId, ['feishu', 'qq', 'wechat', 'telegram']],
      )
      return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        email: row.email,
        isActive: row.is_active,
        accountStatus: row.account_status,
        securityVersion: row.security_version,
        avatarUrl: row.avatar ? `/api/v1/auth/avatar/${row.id}` : null,
        createdAt: row.created_at,
        timezone: row.timezone,
        emailSubscribed: row.email_subscribed ?? false,
        imChannels: bots.map((bot) => bot.platform),
      }
    },
    async markUserActive(userId) {
      await pool.query(
        `UPDATE users
         SET last_active_at = CURRENT_TIMESTAMP
         WHERE id = $1
           AND (last_active_at IS NULL OR last_active_at < CURRENT_TIMESTAMP - INTERVAL '1 hour')`,
        [userId],
      )
    },
  }
}
