import type { Pool } from 'pg'
import type { PreferencesStore } from '../preferences.js'
import { createLocalPreferenceTextFiles } from './personality-files.js'
import { decryptSmtpPassword, encryptSmtpPassword } from './smtp-credentials.js'
import type { UserSmtpSettings, UserSmtpSettingsStore } from '../smtp.js'

interface PreferencesRow {
  data_json: string
}

/** PostgreSQL persistence for the Python-compatible per-user preference document. */
export function createPostgresPreferencesStore(
  pool: Pick<Pool, 'query'>,
  options?: {
    storageRoot?: string
    secretKey?: string
    personalityPreferenceAvailable?: boolean
    bumpContextRevision?(ownerId: string, resource: 'preferences'): Promise<unknown>
  },
): PreferencesStore {
  return {
    ...(options?.secretKey ? {
      smtp: createPostgresUserSmtpSettingsStore(pool, options.secretKey),
    } : {}),
    ...(options?.storageRoot ? { textFiles: createLocalPreferenceTextFiles(options.storageRoot) } : {}),
    ...(options?.personalityPreferenceAvailable === undefined
      ? {} : { personalityPreferenceAvailable: options.personalityPreferenceAvailable }),
    async invalidatePersonalitySnapshots(ownerId) {
      await pool.query(
        'UPDATE conversation_sessions SET snapshot_expires_at = CURRENT_TIMESTAMP WHERE user_id = $1',
        [ownerId],
      )
    },
    async bumpPreferencesContextRevision(ownerId) {
      await options?.bumpContextRevision?.(ownerId, 'preferences')
    },
    async read(ownerId) {
      const result = await pool.query<PreferencesRow & Record<string, unknown>>(
        'SELECT data_json FROM user_preferences WHERE user_id = $1',
        [ownerId],
      )
      return result.rows[0]?.data_json ?? null
    },

    async write(ownerId, data) {
      await pool.query(
        `INSERT INTO user_preferences (user_id, data_json, updated_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO UPDATE
         SET data_json = EXCLUDED.data_json,
             updated_at = CURRENT_TIMESTAMP`,
        [ownerId, JSON.stringify(data)],
      )
    },
  }
}

function createPostgresUserSmtpSettingsStore(
  pool: Pick<Pool, 'query'>,
  secretKey: string,
): UserSmtpSettingsStore {
  return {
    async read(ownerId) {
      const result = await pool.query<{
        host: string; port: number; user: string; from_addr: string; use_ssl: boolean; enabled: boolean
      } & Record<string, unknown>>(
        `SELECT host, port, "user", from_addr, use_ssl, enabled
         FROM user_smtp_configs WHERE user_id = $1`,
        [ownerId],
      )
      const row = result.rows[0]
      return row ? {
        host: row.host,
        port: row.port,
        user: row.user,
        fromAddr: row.from_addr,
        useSsl: row.use_ssl,
        enabled: row.enabled,
      } : null
    },

    async write(ownerId, settings: UserSmtpSettings, password) {
      const encryptedPassword = password === null ? null : encryptSmtpPassword(secretKey, password)
      await pool.query(
        `INSERT INTO user_smtp_configs (user_id, host, port, "user", password, from_addr, use_ssl, enabled, updated_at)
         VALUES ($1, $2, $3, $4, COALESCE($5, ''), $6, $7, $8, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO UPDATE SET
           host = EXCLUDED.host,
           port = EXCLUDED.port,
           "user" = EXCLUDED."user",
           password = CASE WHEN $5::text IS NULL THEN user_smtp_configs.password ELSE EXCLUDED.password END,
           from_addr = EXCLUDED.from_addr,
           use_ssl = EXCLUDED.use_ssl,
           enabled = EXCLUDED.enabled,
           updated_at = CURRENT_TIMESTAMP`,
        [ownerId, settings.host, settings.port, settings.user, encryptedPassword, settings.fromAddr, settings.useSsl, settings.enabled],
      )
    },

    async readPassword(ownerId) {
      const result = await pool.query<{ password: string } & Record<string, unknown>>(
        'SELECT password FROM user_smtp_configs WHERE user_id = $1',
        [ownerId],
      )
      return result.rows[0]?.password ? decryptSmtpPassword(secretKey, result.rows[0].password) : ''
    },
  }
}
