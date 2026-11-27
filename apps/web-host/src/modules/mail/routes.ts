import type { FastifyInstance } from 'fastify'
import { MailError } from '@gugu/email/service'
import { registerProtectedDomain } from '../../http/user.js'
import type { UserAuthOptions } from '../auth/contracts.js'

import { createWebMailRuntime } from './runtime.js'

export function registerMailRoutes(app: FastifyInstance, auth: UserAuthOptions, env = process.env) {
  const { execute } = createWebMailRuntime(env)
  registerProtectedDomain(app, auth, (routes, userFromRequest) => {
    routes.post('/api/v1/mail/command', async (request, reply) => {
      const owner = userFromRequest(request).requestContext.data.ownerId
      reply.header('Cache-Control', 'no-store')
      try { return await execute(String(owner), request.body) }
      catch (error) {
        if (error instanceof MailError) return reply.code(error.status).send({ detail: error.message })
        return reply.code(500).send({ detail: '邮箱服务暂不可用，请稍后重试' })
      }
    })
  })
}
