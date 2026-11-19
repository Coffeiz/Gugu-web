import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ProfileUpdateError, type ProfileUpdateInput, type ProfileUpdateResult } from '@gugu/core/auth/profile-update'
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
  readonly updateProfile: (ownerId: string, input: ProfileUpdateInput) => Promise<ProfileUpdateResult>
  readonly secret: string
  readonly tokenExpiresMinutes?: number
  readonly authenticate: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<ProfileIdentity | null>
  readonly lookupUser: (userId: string) => Promise<ProfileUser | null>
  readonly bumpContextRevision: (userId: string, resource: 'timezone') => Promise<void>
  readonly publishAuthStateChanged: (userId: string) => Promise<unknown>
}

function field(body: Record<string, unknown>, camel: string, snake: string): unknown {
  return body[camel] === undefined ? body[snake] : body[camel]
}

function parseProfileUpdate(body: unknown): ProfileUpdateInput | null {
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

function userResponse(user: ProfileUser) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    isActive: user.isActive,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt instanceof Date
      ? user.createdAt.toISOString().slice(0, 10)
      : user.createdAt?.slice(0, 10) ?? '',
    imChannels: user.imChannels,
    timezone: user.timezone,
    emailSubscribed: user.emailSubscribed,
  }
}

function setRenewedAuthCookies(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  securityVersion: number,
  secret: string,
  tokenExpiresMinutes: number,
): void {
  const forwardedProtocol = request.headers['x-forwarded-proto']
  const secure = request.protocol === 'https'
    || (typeof forwardedProtocol === 'string'
      && forwardedProtocol.split(',', 1)[0]?.trim().toLowerCase() === 'https')
  const secureSuffix = secure ? '; Secure' : ''
  const maxAge = tokenExpiresMinutes * 60
  const accessToken = createUserToken(userId, securityVersion, secret, Date.now(), tokenExpiresMinutes)
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
    try {
      const committed = await options.updateProfile(identity.id, update)
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
          options.tokenExpiresMinutes ?? 10080,
        )
      }
      return userResponse(user)
    } catch (error) {
      if (error instanceof ProfileUpdateError) {
        const statusCode = error.code === 'not_found' ? 404 : 400
        return reply.code(statusCode).send({ detail: error.message })
      }
      throw error
    }
  })
}
