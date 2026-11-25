import { updateProfile as updateUserProfile } from '@gugu/users'
import { changePasswordBodySchema } from '@gugu/auth/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ProfileUpdateError, type ProfileUpdateInput, type ProfileUpdateResult } from './profile-update.js'
import { createCsrfToken, createUserToken } from '../session/token.js'

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

function parseUsersProfileUpdate(body: unknown): ProfileUpdateInput | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  if (Object.keys(body).some(key => key !== 'displayName' && key !== 'timezone' && key !== 'emailSubscribed')) return null
  const { displayName, timezone, emailSubscribed } = body as Record<string, unknown>
  if (displayName != null && typeof displayName !== 'string') return null
  if (timezone != null && typeof timezone !== 'string') return null
  if (emailSubscribed !== undefined && typeof emailSubscribed !== 'boolean') return null
  return { displayName, timezone, emailSubscribed }
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
  async function renewAfterPasswordChange(
    request: FastifyRequest, reply: FastifyReply, userId: string, result: ProfileUpdateResult,
  ) {
    try {
      await options.publishAuthStateChanged(userId)
    } catch {
      // 密码和安全版本已提交，通知失败不影响续发。
    }
    setRenewedAuthCookies(request, reply, userId, result.securityVersion ?? 1,
      options.secret, options.tokenExpiresMinutes ?? 10080)
  }

  app.post('/api/v1/auth/password/change', async (request, reply) => {
    const identity = await options.authenticate(request, reply)
    if (!identity) return
    const input = changePasswordBodySchema.safeParse(request.body)
    if (!input.success) return reply.code(422).send({ detail: '改密请求字段无效' })
    try {
      const result = await options.updateProfile(identity.id, input.data)
      await renewAfterPasswordChange(request, reply, identity.id, result)
      return reply.code(204).send()
    } catch (error) {
      if (error instanceof ProfileUpdateError)
        return reply.code(error.code === 'not_found' ? 404 : 400).send({ detail: error.message })
      throw error
    }
  })

  app.patch('/api/v1/users/me', async (request, reply) => {
    const identity = await options.authenticate(request, reply)
    if (!identity) return
    const input = parseUsersProfileUpdate(request.body)
    if (!input) return reply.code(422).send({ detail: '个人资料请求字段无效' })
    try {
      const profile = await updateUserProfile(identity.id, input, options)
      return profile ?? reply.code(404).send({ detail: '用户不存在' })
    } catch (error) {
      if (error instanceof ProfileUpdateError)
        return reply.code(error.code === 'not_found' ? 404 : 400).send({ detail: error.message })
      throw error
    }
  })
}
