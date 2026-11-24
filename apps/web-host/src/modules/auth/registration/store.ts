import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Pool, PoolClient } from 'pg'
import { isPostgresUniqueViolation } from '../../../adapters/database/postgres-errors.js'
import type { PublicUserRecord } from '../session/token.js'
import {
  RegistrationRequestError,
  type RegistrationCodeProof,
  type RegistrationInput,
} from './routes.js'

export interface RegistrationCodeTransactionPort {
  remainingTtlMs(email: string): Promise<number>
  /** Atomically compares and removes this exact code; false means absent, expired or replaced. */
  consume(email: string, code: string): Promise<boolean>
  /** Must restore with NX and the supplied remaining TTL so a newer code is never overwritten. */
  restore(email: string, code: string, remainingTtlMs: number): Promise<void>
}

export interface PostgresRegistrationDependencies {
  /** Required even for deployments with verification disabled; no implicit in-memory fallback. */
  registrationCodes: RegistrationCodeTransactionPort
  /** Must write only a safe diagnostic marker and must not expose email/code values. */
  onCodeRestoreFailure: (error: unknown) => void
  newUserId?: () => string
  now?: () => Date
  monotonicNow?: () => number
}

interface InsertedUser {
  id: string
  username: string
  display_name: string | null
  email: string
  is_active: boolean
  account_status: string
  security_version: number
  avatar: string | null
  created_at: Date | string
  timezone: string | null
  email_subscribed: boolean
}

interface RegistrationOperations {
  userExists(username: string, normalizedEmail: string): Promise<boolean>
  emailIsOccupied(normalizedEmail: string): Promise<boolean>
  registerUser(input: RegistrationInput, proof: RegistrationCodeProof | null): Promise<PublicUserRecord>
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK')
  } catch {
    // Retain the operation error; the pool client is released below.
  }
}

function publicUser(row: InsertedUser): PublicUserRecord {
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
    emailSubscribed: row.email_subscribed,
    imChannels: [],
  }
}

/** 同事务创建账号和偏好。 */
export function createPostgresRegistrationOperations(
  pool: Pick<Pool, 'connect' | 'query'>,
  dependencies: PostgresRegistrationDependencies,
): RegistrationOperations {
  const newUserId = dependencies.newUserId ?? randomUUID
  const now = dependencies.now ?? (() => new Date())
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now())

  return {
    async userExists(username, normalizedEmail) {
      const result = await pool.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM users WHERE username = $1 OR lower(email) = lower($2)
         ) AS present`,
        [username, normalizedEmail],
      )
      return result.rows[0]?.present ?? false
    },

    async emailIsOccupied(normalizedEmail) {
      const result = await pool.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM users WHERE lower(email) = lower($1)
         ) AS present`,
        [normalizedEmail],
      )
      return result.rows[0]?.present ?? false
    },

    async registerUser(input, proof) {
      if (proof && proof.email !== input.email)
        throw new RegistrationRequestError('验证码错误或已过期', 400)

      const client = await pool.connect()
      let transactionOpen = false
      let consumedTtlMs = 0
      let consumedAt = 0
      let codeConsumed = false
      try {
        await client.query('BEGIN')
        transactionOpen = true
        const timestamp = now()
        const inserted = await client.query<InsertedUser>(
          `INSERT INTO users (
             id, username, email, hashed_password, display_name, is_active, account_status,
             security_version, avatar, created_at, timezone, email_subscribed, is_developer
           ) VALUES ($1, $2, $3, $4, $5, TRUE, 'active', 1, NULL, $6, NULL, $7, FALSE)
           RETURNING id::text, username, display_name, email, is_active, account_status,
                     security_version, avatar, created_at, timezone, email_subscribed`,
          [newUserId(), input.username, input.email, input.hashedPassword, input.displayName, timestamp, input.emailSubscribed],
        )
        const userRow = inserted.rows[0]
        if (!userRow) throw new Error('注册用户插入后未返回记录')

        if (input.locale) {
          await client.query(
            `INSERT INTO user_preferences (user_id, data_json, updated_at)
             VALUES ($1, $2, $3)`,
            [userRow.id, JSON.stringify({ locale: input.locale }), timestamp],
          )
        }

        if (proof) {
          try {
            consumedTtlMs = await dependencies.registrationCodes.remainingTtlMs(proof.email)
            consumedAt = monotonicNow()
            codeConsumed = await dependencies.registrationCodes.consume(proof.email, proof.code)
          } catch {
            throw new RegistrationRequestError('验证码服务暂不可用，请稍后重试', 503)
          }
          if (!codeConsumed)
            throw new RegistrationRequestError('验证码错误或已过期', 400)
        }

        try {
          await client.query('COMMIT')
          transactionOpen = false
        } catch (commitError) {
          await rollback(client)
          transactionOpen = false
          if (proof && codeConsumed) {
            const remainingTtlMs = consumedTtlMs - Math.trunc(monotonicNow() - consumedAt)
            if (remainingTtlMs > 0) {
              try {
                await dependencies.registrationCodes.restore(proof.email, proof.code, remainingTtlMs)
              } catch (restoreError) {
                try {
                  dependencies.onCodeRestoreFailure(restoreError)
                } catch {
                  // Recovery diagnostics must not replace the PostgreSQL commit error.
                }
              }
            }
          }
          throw commitError
        }

        return publicUser(userRow)
      } catch (error) {
        if (transactionOpen) await rollback(client)
        if (isPostgresUniqueViolation(error))
          throw new RegistrationRequestError('用户名或邮箱已被注册', 400)
        throw error
      } finally {
        client.release()
      }
    },
  }
}
