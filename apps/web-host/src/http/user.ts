import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { requestContext } from '@gugu/core'
import { authenticateUser, AuthenticationError } from '../modules/auth/session/token.js'
import type { UserAuthOptions } from '../modules/auth/contracts.js'
import { requiresDataReplacementWriteGate } from '@gugu/core/data-portability/write-gate'
import { registerAuthenticatedDomain } from './authenticated-domain.js'
import type { AuthenticatedWebUser } from './options.js'

export async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: UserAuthOptions,
): Promise<AuthenticatedWebUser | null> {
  try {
    const { identity, user } = await authenticateUser({
      method: request.method,
      authorization: typeof request.headers.authorization === 'string'
        ? request.headers.authorization
        : undefined,
      cookie: request.headers.cookie,
      csrfHeader: typeof request.headers['x-csrf-token'] === 'string'
        ? request.headers['x-csrf-token']
        : undefined,
    }, auth.secret, auth.lookupUser)
    await auth.markUserActive?.(user.id)
    if (auth.isDataReplacementWriteLocked && requiresDataReplacementWriteGate(request.method, request.url.split('?', 1)[0] ?? '')) {
      try {
        if (await auth.isDataReplacementWriteLocked(user.id)) {
          reply.code(423).header('Retry-After', '5').send({ detail: '账号正在替换用户数据，暂时不能修改；请稍后重试' })
          return null
        }
      } catch {
        reply.code(503).send({ detail: '账号状态暂不可用，请稍后重试' })
        return null
      }
    }
    return {
      ...user,
      requestContext: requestContext({
        userId: identity.userId,
        securityVersion: identity.securityVersion,
      }),
    }
  } catch (error) {
    if (error instanceof AuthenticationError) {
      reply.code(error.statusCode).send({ detail: error.message })
      return null
    }
    throw error
  }
}

export function registerProtectedDomain(
  app: FastifyInstance,
  auth: UserAuthOptions,
  registerRoutes: Parameters<typeof registerAuthenticatedDomain<AuthenticatedWebUser>>[2],
) {
  return registerAuthenticatedDomain<AuthenticatedWebUser>(
    app,
    (request, reply) => authenticateRequest(request, reply, auth),
    registerRoutes,
  )
}
