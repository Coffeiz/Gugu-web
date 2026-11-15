import type { Pool } from 'pg'
import type { PreferenceDocumentStore } from '@gugu/core'
import type { PreferencesStore } from '../preferences.js'
import { createLocalPreferenceTextFiles } from './personality-files.js'
import { decryptEncryptedString as decryptSmtpPassword } from '../../../adapters/encrypted-string.js'
import type { UserSmtpSettings, UserSmtpSettingsStore } from '../smtp.js'

/** PostgreSQL persistence for the Python-compatible per-user preference document. */
export function createPostgresPreferencesStore(
  pool: Pick<Pool, 'query'>,
  options: {
    storageRoot?: string
    secretKey?: string
    documentStore: PreferenceDocumentStore
    smtpSettings?: {
      get(ownerId: string): Promise<UserSmtpSettings | null>
      put(ownerId: string, body: unknown): Promise<UserSmtpSettings>
    }
    personalityPreferenceAvailable?: boolean
    bumpContextRevision?(ownerId: string, resource: 'preferences'): Promise<unknown>
  },
): PreferencesStore {
  if (options.secretKey && !options.smtpSettings) throw new Error('SMTP 设置服务未配置')
  return {
    ...(options?.secretKey ? {
      smtp: createPostgresUserSmtpSettingsStore(pool, options.secretKey, options.smtpSettings!),
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
    read: ownerId => options.documentStore.read(ownerId),
    write: (ownerId, data) => options.documentStore.write(ownerId, data),
  }
}

function createPostgresUserSmtpSettingsStore(
  pool: Pick<Pool, 'query'>,
  secretKey: string,
  core: NonNullable<Parameters<typeof createPostgresPreferencesStore>[1]['smtpSettings']>,
): UserSmtpSettingsStore {
  return {
    read: ownerId => core.get(ownerId),

    async write(ownerId, settings: UserSmtpSettings, password) {
      await core.put(ownerId, { ...settings, password })
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
