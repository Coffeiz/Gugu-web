import type { FastifyInstance } from 'fastify'
import { createMailService, MailError } from '@gugu/core/mail/service'
import { createMailTransport } from '@gugu/core/mail/transport'
import { registerProtectedDomain } from '../../http/user.js'
import type { UserAuthOptions } from '../auth/contracts.js'
import { createWebMailStore } from './store.js'

export function registerMailRoutes(app: FastifyInstance, auth: UserAuthOptions, env = process.env) {
  const execute = createMailService(createWebMailStore(env), createMailTransport())
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
