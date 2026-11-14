import bcrypt from 'bcryptjs'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import { createCsrfToken, createUserToken } from '../auth.js'

export interface ProfileUser {
  readonly id: string
  readonly username: string
  readonly displayName: string | null
  readonly email: string
  readonly isActive: boolean
  readonly avatarUrl: string | null
  readonly createdAt: Date | string | null
  readonly timezone: string | null
  readonly emailSubscribed: boolean
  readonly imChannels: readonly string[]
  readonly securityVersion?: number | null
}

export interface ProfileIdentity {
  readonly id: string
}

export interface ProfileRouteOptions {
  readonly pool: Pick<Pool, 'connect'>
  readonly secret: string
  readonly authenticate: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<ProfileIdentity | null>
  readonly lookupUser: (userId: string) => Promise<ProfileUser | null>
  readonly bumpContextRevision: (userId: string, resource: 'timezone') => Promise<void>
  readonly publishAuthStateChanged: (userId: string) => Promise<unknown>
}

interface ProfileUpdate {
  readonly displayName?: string
  readonly timezone?: string
  readonly emailSubscribed?: boolean
  readonly currentPassword?: string
  readonly newPassword?: string
}

interface PersistedProfileUpdate {
  readonly timezoneChanged: boolean
  readonly passwordChanged: boolean
  readonly securityVersion: number | null
}

interface ProfileRow {
  readonly timezone: string | null
  readonly hashed_password: string
  readonly security_version: number | null
}

export class ProfileRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404,
  ) {
    super(message)
    this.name = 'ProfileRequestError'
  }
}

function field(body: Record<string, unknown>, camel: string, snake: string): unknown {
  return body[camel] === undefined ? body[snake] : body[camel]
}

function parseProfileUpdate(body: unknown): ProfileUpdate | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  const displayName = field(value, 'displayName', 'display_name')
  const timezone = value.timezone
  const emailSubscribed = field(value, 'emailSubscribed', 'email_subscribed')
  const currentPassword = field(value, 'currentPassword', 'current_password')
  const newPassword = field(value, 'newPassword', 'new_password')
  if (displayName !== undefined && displayName !== null && typeof displayName !== 'string') return null
  if (timezone !== undefined && timezone !== null && typeof timezone !== 'string') return null
  if (emailSubscribed !== undefined && emailSubscribed !== null && typeof emailSubscribed !== 'boolean') return null
  if (currentPassword !== undefined && currentPassword !== null && typeof currentPassword !== 'string') return null
  if (newPassword !== undefined && newPassword !== null && typeof newPassword !== 'string') return null
  return {
    ...(typeof displayName === 'string' ? { displayName } : {}),
    ...(typeof timezone === 'string' ? { timezone } : {}),
    ...(typeof emailSubscribed === 'boolean' ? { emailSubscribed } : {}),
    ...(typeof currentPassword === 'string' ? { currentPassword } : {}),
    ...(typeof newPassword === 'string' ? { newPassword } : {}),
  }
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0)
    return true
  } catch {
    return false
  }
}

async function persistProfileUpdate(
  pool: Pick<Pool, 'connect'>,
  userId: string,
  update: ProfileUpdate,
): Promise<PersistedProfileUpdate> {
  return withPostgresTransaction(pool, async (client) => {
    const result = await client.query<ProfileRow>(
      'SELECT timezone, hashed_password, security_version FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    )
    const current = result.rows[0]
    if (!current) throw new ProfileRequestError('用户不存在', 404)

    const values: unknown[] = [userId]
    const assignments: string[] = []
    if (update.displayName !== undefined) {
      values.push(update.displayName.trim() || null)
      assignments.push(`display_name = $${values.length}`)
    }
    let timezoneChanged = false
    if (update.timezone !== undefined) {
      const timezone = update.timezone.trim()
      timezoneChanged = timezone !== (current.timezone || '')
      values.push(timezone || null)
      assignments.push(`timezone = $${values.length}`)
    }
    if (update.emailSubscribed !== undefined) {
      values.push(update.emailSubscribed)
      assignments.push(`email_subscribed = $${values.length}`)
    }

    const passwordChanged = Boolean(update.newPassword)
    if (passwordChanged) {
      if (!update.currentPassword)
        throw new ProfileRequestError('请输入当前密码', 400)
      if (!await bcrypt.compare(update.currentPassword, current.hashed_password))
        throw new ProfileRequestError('当前密码错误', 400)
      values.push(await bcrypt.hash(update.newPassword!, 12))
      assignments.push(`hashed_password = $${values.length}`)
      assignments.push('security_version = COALESCE(security_version, 0) + 1')
    }

    let securityVersion = current.security_version
    if (assignments.length) {
      const updated = await client.query<{ security_version: number | null }>(
        `UPDATE users SET ${assignments.join(', ')} WHERE id = $1 RETURNING security_version`,
        values,
      )
      if (!updated.rows[0]) throw new ProfileRequestError('用户不存在', 404)
      securityVersion = updated.rows[0].security_version
    }
    return { timezoneChanged, passwordChanged, securityVersion }
  })
}

function userResponse(user: ProfileUser) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.displayName,
    email: user.email,
    is_active: user.isActive,
    avatar_url: user.avatarUrl,
    created_at: user.createdAt instanceof Date
      ? user.createdAt.toISOString().slice(0, 10)
      : user.createdAt?.slice(0, 10) ?? '',
    im_channels: user.imChannels,
    timezone: user.timezone,
    email_subscribed: user.emailSubscribed,
  }
}

function setRenewedAuthCookies(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  securityVersion: number,
  secret: string,
): void {
  const forwardedProtocol = request.headers['x-forwarded-proto']
  const secure = request.protocol === 'https'
    || (typeof forwardedProtocol === 'string'
      && forwardedProtocol.split(',', 1)[0]?.trim().toLowerCase() === 'https')
  const secureSuffix = secure ? '; Secure' : ''
  const maxAge = 10080 * 60
  const accessToken = createUserToken(userId, securityVersion, secret)
  const csrfToken = createCsrfToken()
  reply.header('set-cookie', [
    `gugu_user_access_token=${accessToken}; Max-Age=${maxAge}; Path=/; HttpOnly${secureSuffix}; SameSite=Lax`,
    `gugu_user_csrf_token=${csrfToken}; Max-Age=${maxAge}; Path=/${secureSuffix}; SameSite=Lax`,
  ])
}

export function registerProfileRoute(app: FastifyInstance, options: ProfileRouteOptions): void {
  app.patch('/api/v1/auth/profile', async (request, reply) => {
    const identity = await options.authenticate(request, reply)
    if (!identity) return
    const update = parseProfileUpdate(request.body)
    if (!update) return reply.code(422).send({ detail: '个人资料请求字段无效' })
    if (update.timezone !== undefined && update.timezone.trim() && !isValidTimezone(update.timezone.trim()))
      return reply.code(400).send({ detail: '无效的时区' })

    try {
      const committed = await persistProfileUpdate(options.pool, identity.id, update)
      if (committed.timezoneChanged)
        await options.bumpContextRevision(identity.id, 'timezone')

      const user = await options.lookupUser(identity.id)
      if (!user) return reply.code(404).send({ detail: '用户不存在' })

      if (committed.passwordChanged) {
        try {
          await options.publishAuthStateChanged(identity.id)
        } catch {
          // Password and token-version changes are already committed.
        }
        setRenewedAuthCookies(
          request,
          reply,
          identity.id,
          committed.securityVersion ?? 1,
          options.secret,
        )
      }
      return userResponse(user)
    } catch (error) {
      if (error instanceof ProfileRequestError)
        return reply.code(error.statusCode).send({ detail: error.message })
      throw error
    }
  })
}
