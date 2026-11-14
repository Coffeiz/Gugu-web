import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createCsrfToken, createUserToken, type PublicUserRecord } from '../auth.js'
import type { UserAuthOptions } from '../contracts.js'
import { RateLimitError } from '../rate-limit.js'
import { validateDto } from '../../../http/dto.js'
import { loginBodySchema } from '../../../http/dtos.js'
import { userResponse } from '../user-response.js'

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
    const token = createUserToken(user.id, securityVersion, auth.secret)
    const maxAge = 10080 * 60
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
    }
  })
}

export function registerCurrentUserRoute(
  app: FastifyInstance,
  userFromRequest: (request: FastifyRequest) => PublicUserRecord,
): void {
  app.get('/api/v1/auth/me', (request) => userResponse(userFromRequest(request)))
}
