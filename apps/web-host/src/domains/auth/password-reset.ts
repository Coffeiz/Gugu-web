import { randomBytes, createHash } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { withPostgresTransaction } from '../../adapters/postgres-transaction.js'
import { RateLimitError, type RateLimitHandler } from './rate-limit.js'

export const PASSWORD_RESET_TTL_SECONDS = 30 * 60
export const PASSWORD_RESET_COOLDOWN_SECONDS = 60
export const PASSWORD_RESET_GENERIC = Object.freeze({
  ok: true,
  message: '若该邮箱已注册，重置链接已发送，请查收邮箱（含垃圾箱）。',
})

export interface PasswordResetUser {
  readonly id: string
  readonly email: string
  readonly username: string
  readonly displayName: string | null
}

export interface PasswordResetStore {
  findByIdentifier(identifier: string): Promise<PasswordResetUser | null>
  setPassword(userId: string, passwordHash: string): Promise<boolean>
}

export interface PasswordResetRedisCommands {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...options: string[]): Promise<string | null>
  del(...keys: string[]): Promise<number>
  claim(tokenKey: string, claimKey: string): Promise<string | null>
  restore(tokenKey: string, claimKey: string, userId: string): Promise<boolean>
}

export interface PasswordResetRouteOptions {
  readonly store: PasswordResetStore
  readonly redis: PasswordResetRedisCommands | null
  readonly rateLimit: RateLimitHandler
  readonly systemEmailAvailable: boolean
  readonly publicAppUrl?: string
  readonly sendResetEmail: (input: { to: string; username: string; link: string }) => Promise<boolean>
  readonly publishAuthStateChanged: (userId: string) => Promise<unknown>
  readonly createToken?: () => string
}

export class PasswordResetError extends Error {
  constructor(message: string, readonly statusCode: 400 | 503) {
    super(message)
    this.name = 'PasswordResetError'
  }
}

export function maskResetEmail(value: string): string {
  const [local, ...domainParts] = value.trim().toLowerCase().split('@')
  const domain = domainParts.join('@')
  if (!local || !domain) return ''
  const maskedLocal = local.length === 1 ? '*' : `${local[0]}***${local.length > 2 ? local.at(-1) : ''}`
  return `${maskedLocal}@${domain}`
}

function resetBody(body: unknown): { identifier?: string; token?: string; newPassword?: string } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  const identifier = value.email
  const token = value.token
  const newPassword = value.newPassword === undefined ? value.new_password : value.newPassword
  if (identifier !== undefined && typeof identifier !== 'string') return null
  if (token !== undefined && typeof token !== 'string') return null
  if (newPassword !== undefined && typeof newPassword !== 'string') return null
  return {
    ...(typeof identifier === 'string' ? { identifier: identifier.trim().toLowerCase() } : {}),
    ...(typeof token === 'string' ? { token: token.trim() } : {}),
    ...(typeof newPassword === 'string' ? { newPassword } : {}),
  }
}

function requestOrigin(request: FastifyRequest, configured?: string): string {
  if (configured) return configured.replace(/\/+$/, '')
  const protocolHeader = request.headers['x-forwarded-proto']
  const hostHeader = request.headers['x-forwarded-host']
  const protocol = typeof protocolHeader === 'string'
    ? protocolHeader.split(',', 1)[0]!.trim().toLowerCase()
    : request.protocol
  const host = typeof hostHeader === 'string'
    ? hostHeader.split(',', 1)[0]!.trim()
    : request.headers.host
  if (!host || !['http', 'https'].includes(protocol) || /[\s\r\n]/.test(host))
    throw new PasswordResetError('密码找回邮件当前不可用', 503)
  try {
    return new URL(`${protocol}://${host}`).origin
  } catch {
    throw new PasswordResetError('密码找回邮件当前不可用', 503)
  }
}

function recoverFailure(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof RateLimitError || error instanceof PasswordResetError) {
    reply.code(error.statusCode).send({ detail: error.message })
    return true
  }
  return false
}

export function registerPasswordResetRoutes(app: FastifyInstance, options: PasswordResetRouteOptions): void {
  const createToken = options.createToken ?? (() => randomBytes(32).toString('base64url'))
  app.post('/api/v1/auth/forgot-password', async (request, reply) => {
    try {
      await options.rateLimit(request, {
        bucket: 'forgot', limit: 5, windowSeconds: 3600, failClosed: true,
      })
      const body = resetBody(request.body)
      if (!body) return reply.code(422).send({ detail: '找回密码请求字段无效' })
      const identifier = body.identifier ?? ''
      if (!identifier) return PASSWORD_RESET_GENERIC
      if (!options.systemEmailAvailable || !options.redis)
        throw new PasswordResetError('密码找回邮件当前不可用', 503)

      const user = await options.store.findByIdentifier(identifier)
      if (!user) return PASSWORD_RESET_GENERIC
      const email = user.email.trim().toLowerCase()
      const response = { ...PASSWORD_RESET_GENERIC, maskedEmail: maskResetEmail(email) }
      const cooldownKey = `pwdreset:cd:${email}`
      const reserved = await options.redis.set(
        cooldownKey, '1', 'EX', String(PASSWORD_RESET_COOLDOWN_SECONDS), 'NX',
      )
      if (reserved !== 'OK') return response

      const token = createToken()
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
        await options.redis.del(cooldownKey)
        throw new Error('Password reset token generator returned an invalid token')
      }
      const tokenKey = `pwdreset:tok:${token}`
      try {
        await options.redis.set(tokenKey, user.id, 'EX', String(PASSWORD_RESET_TTL_SECONDS))
      } catch (error) {
        await options.redis.del(cooldownKey).catch(() => 0)
        throw error
      }
      let sent = false
      try {
        const link = `${requestOrigin(request, options.publicAppUrl)}/reset-password?token=${encodeURIComponent(token)}`
        sent = await options.sendResetEmail({
          to: user.email,
          username: user.displayName?.trim() || user.username,
          link,
        })
      } catch {
        // Delivery errors stay private; the response must not reveal account or mail details.
      }
      if (sent) return response
      await options.redis.del(tokenKey, cooldownKey)
      return PASSWORD_RESET_GENERIC
    } catch (error) {
      if (recoverFailure(reply, error)) return
      throw error
    }
  })

  app.post('/api/v1/auth/reset-password', async (request, reply) => {
    try {
      const body = resetBody(request.body)
      if (!body || body.token === undefined || body.newPassword === undefined)
        return reply.code(422).send({ detail: '重置密码请求字段无效' })
      if (body.newPassword.length < 8) throw new PasswordResetError('密码至少 8 位', 400)
      if (!body.token) throw new PasswordResetError('链接无效', 400)
      if (!options.redis) throw new PasswordResetError('密码重置服务暂不可用', 503)

      const tokenKey = `pwdreset:tok:${body.token}`
      const claimKey = `pwdreset:claim:${createHash('sha256').update(body.token).digest('hex')}`
      const userId = await options.redis.claim(tokenKey, claimKey)
      if (!userId) throw new PasswordResetError('链接已失效或已被使用，请重新申请', 400)
      try {
        const updated = await options.store.setPassword(userId, await bcrypt.hash(body.newPassword, 12))
        if (!updated) {
          await options.redis.del(claimKey)
          throw new PasswordResetError('账号不存在', 400)
        }
      } catch (error) {
        if (error instanceof PasswordResetError) throw error
        await options.redis.restore(tokenKey, claimKey, userId).catch(() => false)
        throw error
      }

      await options.redis.del(claimKey)
      await options.publishAuthStateChanged(userId)
      reply.header('set-cookie', [
        'gugu_user_access_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
        'gugu_user_csrf_token=; Max-Age=0; Path=/; SameSite=Lax',
      ])
      return { ok: true }
    } catch (error) {
      if (recoverFailure(reply, error)) return
      throw error
    }
  })
}

export function createPostgresPasswordResetStore(pool: Pick<Pool, 'query' | 'connect'>): PasswordResetStore {
  return {
    async findByIdentifier(identifier) {
      const result = await pool.query<PasswordResetUser>(
        `SELECT id::text, email, username, display_name AS "displayName"
         FROM users WHERE lower(username) = $1 OR lower(email) = $1 LIMIT 1`,
        [identifier],
      )
      return result.rows[0] ?? null
    },
    async setPassword(userId, passwordHash) {
      return withPostgresTransaction(pool, async (client) => {
        const current = await client.query<{ id: string }>(
          'SELECT id::text FROM users WHERE id = $1 FOR UPDATE', [userId],
        )
        if (!current.rows[0]) return false
        await client.query(
          `UPDATE users SET hashed_password = $2,
             security_version = COALESCE(security_version, 0) + 1 WHERE id = $1`,
          [userId, passwordHash],
        )
        return true
      })
    },
  }
}
