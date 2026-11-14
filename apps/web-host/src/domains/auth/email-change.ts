import { createHash, randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../adapters/postgres-transaction.js'
import { RateLimitError, type RateLimitHandler } from './rate-limit.js'

export const EMAIL_CHANGE_TTL_SECONDS = 30 * 60

export interface EmailChangeUser {
  readonly id: string
  readonly email: string
  readonly username: string
  readonly displayName: string | null
  readonly passwordHash: string | null
}

export interface ActiveEmailChange {
  readonly id: number
  readonly email: string
  readonly expiresAt: Date
}

export type EmailChangeCompletion =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'user_missing' }
  | { readonly kind: 'occupied' }
  | { readonly kind: 'completed'; readonly user: EmailChangeUser }

export interface EmailChangeStore {
  findUser(userId: string): Promise<EmailChangeUser | null>
  emailOccupied(email: string, excludingUserId: string): Promise<boolean>
  createRequest(userId: string, email: string, tokenHash: string, expiresAt: Date): Promise<void>
  activeRequest(userId: string): Promise<ActiveEmailChange | null>
  replaceActiveToken(userId: string, tokenHash: string, expiresAt: Date): Promise<ActiveEmailChange | null>
  revokeActive(userId: string): Promise<void>
  completeToken(tokenHash: string): Promise<EmailChangeCompletion>
}

export interface EmailChangeMail {
  sendVerification(input: { to: string; username: string; link: string }): Promise<boolean>
  sendNotice(input: { to: string; username: string; kind: 'requested' | 'completed' }): Promise<boolean>
}

export interface EmailChangeOptions {
  readonly store: EmailChangeStore
  readonly rateLimit: RateLimitHandler
  readonly systemEmailAvailable: boolean
  readonly publicAppUrl?: string
  readonly mail: EmailChangeMail | null
  readonly publishAuthStateChanged: (userId: string) => Promise<unknown>
  readonly createToken?: () => string
}

export interface EmailChangeUserRouteOptions extends EmailChangeOptions {
  ownerIdFromRequest(request: FastifyRequest): string
}

export function normalizeEmailChangeAddress(value: string): string | null {
  const email = value.trim().toLowerCase()
  if (email.length > 300 || !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(email)) return null
  return email
}

export function hashEmailChangeToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function bodyRecord(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
}

function configuredOrigin(request: FastifyRequest, configured?: string): string | null {
  if (configured) return configured.replace(/\/+$/, '')
  const host = request.headers.host
  if (!host || /[\s\r\n]/.test(host)) return null
  try {
    return new URL(`${request.protocol}://${host}`).origin
  } catch {
    return null
  }
}

function sendFailure(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof RateLimitError) {
    reply.code(error.statusCode).send({ detail: error.message })
    return true
  }
  return false
}

function unavailable(reply: FastifyReply): FastifyReply {
  return reply.code(503).send({ detail: '邮箱变更功能当前不可用' })
}

function emailMask(email: string): string {
  const at = email.lastIndexOf('@')
  return at < 0 ? '' : `${email.slice(0, 2)}***${email.slice(at)}`
}

export function registerEmailChangeUserRoutes(app: FastifyInstance, options: EmailChangeUserRouteOptions): void {
  const createToken = options.createToken ?? (() => randomBytes(32).toString('base64url'))

  app.post('/api/v1/auth/email-change/request', async (request, reply) => {
    const ownerId = options.ownerIdFromRequest(request)
    try {
      await options.rateLimit(request, { bucket: 'email-change', limit: 3, windowSeconds: 3600, extra: ownerId })
      if (!options.systemEmailAvailable || !options.mail) return unavailable(reply)
      const body = bodyRecord(request.body)
      if (!body || typeof body.newEmail !== 'string' || typeof body.currentPassword !== 'string')
        return reply.code(422).send({ detail: '邮箱变更请求字段无效' })
      const email = normalizeEmailChangeAddress(body.newEmail)
      if (!email) return reply.code(400).send({ detail: '请输入有效的邮箱地址' })
      const user = await options.store.findUser(ownerId)
      if (!user) return reply.code(401).send({ detail: '认证失败' })
      if (!user.passwordHash || !await bcrypt.compare(body.currentPassword, user.passwordHash))
        return reply.code(400).send({ detail: '当前密码错误' })
      if (email === user.email.trim().toLowerCase())
        return reply.code(400).send({ detail: '新邮箱不能与当前邮箱相同' })
      if (await options.store.emailOccupied(email, ownerId))
        return reply.code(409).send({ detail: '该邮箱已被使用' })

      const token = createToken()
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('Email change token generator returned an invalid token')
      await options.store.createRequest(ownerId, email, hashEmailChangeToken(token), new Date(Date.now() + EMAIL_CHANGE_TTL_SECONDS * 1000))
      const origin = configuredOrigin(request, options.publicAppUrl)
      if (!origin) return reply.code(503).send({ detail: '邮箱变更功能当前不可用' })
      const delivered = await options.mail.sendVerification({
        to: email,
        username: user.displayName?.trim() || user.username,
        link: `${origin}/verify-email-change?token=${encodeURIComponent(token)}`,
      }).catch(() => false)
      if (!delivered) return reply.code(503).send({ detail: '验证邮件发送失败，请稍后重试' })
      await options.mail.sendNotice({
        to: user.email,
        username: user.displayName?.trim() || user.username,
        kind: 'requested',
      }).catch(() => false)
      return { ok: true, email: emailMask(email) }
    } catch (error) {
      if (sendFailure(reply, error)) return
      throw error
    }
  })

  app.post('/api/v1/auth/email-change/resend', async (request, reply) => {
    const ownerId = options.ownerIdFromRequest(request)
    try {
      await options.rateLimit(request, { bucket: 'email-change-resend', limit: 3, windowSeconds: 3600, extra: ownerId })
      if (!options.systemEmailAvailable || !options.mail) return unavailable(reply)
      const active = await options.store.activeRequest(ownerId)
      if (!active || active.expiresAt.getTime() <= Date.now())
        return reply.code(400).send({ detail: '没有可重新发送的邮箱变更申请' })
      const user = await options.store.findUser(ownerId)
      if (!user) return reply.code(401).send({ detail: '认证失败' })
      const token = createToken()
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('Email change token generator returned an invalid token')
      const renewed = await options.store.replaceActiveToken(
        ownerId, hashEmailChangeToken(token), new Date(Date.now() + EMAIL_CHANGE_TTL_SECONDS * 1000),
      )
      if (!renewed) return reply.code(400).send({ detail: '没有可重新发送的邮箱变更申请' })
      const origin = configuredOrigin(request, options.publicAppUrl)
      if (!origin) return reply.code(503).send({ detail: '邮箱变更功能当前不可用' })
      const delivered = await options.mail.sendVerification({
        to: renewed.email,
        username: user.displayName?.trim() || user.username,
        link: `${origin}/verify-email-change?token=${encodeURIComponent(token)}`,
      }).catch(() => false)
      if (!delivered) return reply.code(503).send({ detail: '验证邮件发送失败，请稍后重试' })
      return { ok: true }
    } catch (error) {
      if (sendFailure(reply, error)) return
      throw error
    }
  })

  app.post('/api/v1/auth/email-change/cancel', async (request, reply) => {
    try {
      await options.store.revokeActive(options.ownerIdFromRequest(request))
      return { ok: true }
    } catch (error) {
      if (sendFailure(reply, error)) return
      throw error
    }
  })
}

export function registerEmailChangeVerifyRoute(app: FastifyInstance, options: EmailChangeOptions): void {
  app.post('/api/v1/auth/email-change/verify', async (request, reply) => {
    const body = bodyRecord(request.body)
    if (!body || typeof body.token !== 'string' || !body.token.trim())
      return reply.code(422).send({ detail: '邮箱验证请求字段无效' })
    const result = await options.store.completeToken(hashEmailChangeToken(body.token.trim()))
    if (result.kind === 'invalid') return reply.code(400).send({ detail: '链接已失效或已被使用，请重新申请' })
    if (result.kind === 'user_missing') return reply.code(400).send({ detail: '账号不存在' })
    if (result.kind === 'occupied') return reply.code(409).send({ detail: '该邮箱已被使用' })
    await options.publishAuthStateChanged(result.user.id)
    if (options.mail) {
      await options.mail.sendNotice({
        to: result.user.email,
        username: result.user.displayName?.trim() || result.user.username,
        kind: 'completed',
      }).catch(() => false)
    }
    return { ok: true, message: '邮箱已变更' }
  })
}

export function createPostgresEmailChangeStore(pool: Pick<Pool, 'query' | 'connect'>): EmailChangeStore {
  const withTransaction = <T>(operation: (client: PoolClient) => Promise<T>) =>
    withPostgresTransaction(pool, operation)

  return {
    async findUser(userId) {
      const result = await pool.query<EmailChangeUser>(
        `SELECT id::text, email, username, display_name AS "displayName", hashed_password AS "passwordHash"
         FROM users WHERE id = $1`, [userId],
      )
      return result.rows[0] ?? null
    },
    async emailOccupied(email, excludingUserId) {
      const result = await pool.query<{ occupied: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2) AS occupied',
        [email, excludingUserId],
      )
      return result.rows[0]?.occupied ?? false
    },
    async createRequest(userId, email, tokenHash, expiresAt) {
      await withTransaction(async (client) => {
        const owner = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])
        if (!owner.rows[0]) throw new Error('Email change owner missing')
        await client.query(
          `UPDATE email_change_requests SET revoked_at = CURRENT_TIMESTAMP
           WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [userId],
        )
        await client.query(
          `INSERT INTO email_change_requests (user_id, new_email, token_hash, expires_at)
           VALUES ($1, $2, $3, $4)`, [userId, email, tokenHash, expiresAt],
        )
      })
    },
    async activeRequest(userId) {
      const result = await pool.query<{ id: number; email: string; expiresAt: Date }>(
        `SELECT id, new_email AS email, expires_at AS "expiresAt" FROM email_change_requests
         WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT 1`, [userId],
      )
      return result.rows[0] ?? null
    },
    async replaceActiveToken(userId, tokenHash, expiresAt) {
      return withTransaction(async (client) => {
        await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])
        const active = await client.query<{ id: number; email: string }>(
          `SELECT id, new_email AS email FROM email_change_requests
           WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
           ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [userId],
        )
        if (!active.rows[0]) return null
        const updated = await client.query(
          `UPDATE email_change_requests SET token_hash = $2, expires_at = $3
           WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
          [active.rows[0].id, tokenHash, expiresAt],
        )
        return updated.rowCount === 1 ? { ...active.rows[0], expiresAt } : null
      })
    },
    async revokeActive(userId) {
      await pool.query(
        `UPDATE email_change_requests SET revoked_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [userId],
      )
    },
    async completeToken(tokenHash) {
      return withTransaction(async (client) => {
        const ownerRef = await client.query<{ userId: string }>(
          `SELECT user_id::text AS "userId" FROM email_change_requests
           WHERE token_hash = $1 AND purpose = 'email_change'`, [tokenHash],
        )
        const userId = ownerRef.rows[0]?.userId
        if (!userId) return { kind: 'invalid' }
        const owner = await client.query<EmailChangeUser>(
          `SELECT id::text, email, username, display_name AS "displayName", hashed_password AS "passwordHash"
           FROM users WHERE id = $1 FOR UPDATE`, [userId],
        )
        const user = owner.rows[0]
        if (!user) return { kind: 'user_missing' }
        const request = await client.query<{
          id: number; userId: string; email: string; expiresAt: Date; usedAt: Date | null; revokedAt: Date | null
        }>(
          `SELECT id, user_id::text AS "userId", new_email AS email, expires_at AS "expiresAt",
                  used_at AS "usedAt", revoked_at AS "revokedAt"
           FROM email_change_requests WHERE token_hash = $1 AND purpose = 'email_change' FOR UPDATE`, [tokenHash],
        )
        const pending = request.rows[0]
        if (!pending || pending.usedAt || pending.revokedAt || pending.expiresAt.getTime() <= Date.now())
          return { kind: 'invalid' }
        const occupied = await client.query<{ occupied: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2) AS occupied',
          [pending.email, userId],
        )
        if (occupied.rows[0]?.occupied) return { kind: 'occupied' }
        await client.query(
          `UPDATE users SET email = $2, security_version = COALESCE(security_version, 0) + 1 WHERE id = $1`,
          [userId, pending.email],
        )
        await client.query('UPDATE email_change_requests SET used_at = CURRENT_TIMESTAMP WHERE id = $1', [pending.id])
        await client.query(
          `UPDATE email_change_requests SET revoked_at = CURRENT_TIMESTAMP
           WHERE user_id = $1 AND id <> $2 AND used_at IS NULL AND revoked_at IS NULL`,
          [userId, pending.id],
        )
        return { kind: 'completed', user: { ...user, email: pending.email } }
      })
    },
  }
}
