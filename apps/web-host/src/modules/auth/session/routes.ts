import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { RemoteLoginResponse } from '@gugu/core/auth/contracts'
import { createCsrfToken, createUserToken, type PublicUserRecord } from './token.js'
import type { UserAuthOptions } from '../contracts.js'
import { RateLimitError } from '../rate-limit.js'
import { validateDto } from '../../../http/dto.js'
import { loginBodySchema } from '../../../http/dtos.js'
import { userResponse } from '../user-response.js'
import { registerProtectedDomain } from '../../../http/user.js'

export function registerLoginRoute(app: FastifyInstance, auth: UserAuthOptions): void {
  const authenticateCredentials = auth.authenticateCredentials
  const recordLogin = auth.recordLogin
  if (!authenticateCredentials || !recordLogin) return
  app.post('/api/v1/auth/login', async (request, reply) => {
    const result = validateDto(loginBodySchema, request.body)
    if (!result.ok) return reply.code(422).send({ detail: '登录请求字段无效' })
    const input = result.value
    try {
      await auth.rateLimit?.(request, {
        bucket: 'login',
        limit: 10,
        windowSeconds: 300,
        extra: input.username,
      })
    } catch (error) {
      if (!(error instanceof RateLimitError)) throw error
      return reply.code(error.statusCode).send({ detail: error.message })
    }

    const user = await authenticateCredentials(input.username, input.password)
    if (!user) return reply.code(401).send({ detail: '用户名或密码错误' })
    if (!user.isActive)
      return reply.code(403).send({ detail: '账号已停用，请联系管理员' })

    await recordLogin(user.id)
    const securityVersion = user.securityVersion || 1
    const expiresMinutes = auth.tokenExpiresMinutes ?? 10080
    const token = createUserToken(user.id, securityVersion, auth.secret, Date.now(), expiresMinutes)
    const maxAge = expiresMinutes * 60
    const forwardedProtocol = request.headers['x-forwarded-proto']
    const secure = request.protocol === 'https'
      || (typeof forwardedProtocol === 'string'
        && forwardedProtocol.split(',', 1)[0]?.trim().toLowerCase() === 'https')
    const secureSuffix = secure ? '; Secure' : ''
    const csrfToken = createCsrfToken()
    reply.header('set-cookie', [
      `gugu_user_access_token=${token}; Max-Age=${maxAge}; Path=/; HttpOnly${secureSuffix}; SameSite=Lax`,
      `gugu_user_csrf_token=${csrfToken}; Max-Age=${maxAge}; Path=/${secureSuffix}; SameSite=Lax`,
    ])
    return {
      access_token: request.headers['x-auth-transport'] === 'cookie' ? null : token,
      token_type: 'bearer',
      user: userResponse(user),
    } satisfies RemoteLoginResponse
  })
}

export function registerCurrentUserRoute(
  app: FastifyInstance,
  userFromRequest: (request: FastifyRequest) => PublicUserRecord,
): void {
  app.get('/api/v1/auth/me', (request) => userResponse(userFromRequest(request)))
}

export interface LogoutUser {
  readonly id: string
}

export interface LogoutRouteOptions {
  authenticate: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<LogoutUser | null>
  /** Resolves only after the new security version has been committed. */
  revokeUserSessions: (userId: string) => Promise<void>
  /** The notifier owns diagnostic logging; notification failure is non-fatal. */
  publishAuthStateChanged: (userId: string) => Promise<unknown>
  removePush?: (userId: string, subscriptionId: unknown) => Promise<void>
}

export function registerLogoutRoute(app: FastifyInstance, options: LogoutRouteOptions): void {
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const user = await options.authenticate(request, reply)
    if (!user) return

    await options.removePush?.(user.id, request.headers['x-gugu-push-subscription'])
    await options.revokeUserSessions(user.id)
    try {
      await options.publishAuthStateChanged(user.id)
    } catch {
      // Session revocation is already durable; a missed live notification must not undo it.
    }

    reply.header('set-cookie', [
      'gugu_user_access_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
      'gugu_user_csrf_token=; Max-Age=0; Path=/; SameSite=Lax',
    ])
    return { ok: true }
  })
}

export function registerSessionRoutes(app: FastifyInstance, auth: UserAuthOptions): void {
  registerLoginRoute(app, auth)
  registerProtectedDomain(app, auth, (routes, userFromRequest) => {
    registerCurrentUserRoute(routes, userFromRequest)
  })
}

export function registerSessionLogout(app: FastifyInstance, auth: UserAuthOptions, removePush?: LogoutRouteOptions['removePush']): void {
  if (auth.revokeUserSessions && auth.publishAuthStateChanged) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerLogoutRoute(routes, {
        async authenticate(request) {
          return { id: userFromRequest(request).id }
        },
        revokeUserSessions: auth.revokeUserSessions!,
        removePush,
        publishAuthStateChanged: auth.publishAuthStateChanged!,
      })
    })
  }
}
