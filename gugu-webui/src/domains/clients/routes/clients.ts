import type { FastifyInstance } from 'fastify'
import type { ClientOptions, UserFromRequest } from '../../../app.js'
import { validateDto } from '../../../http/dto.js'
import { clientCreateBodySchema } from '../../../http/dtos.js'

export function registerClientRoutes(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  clients: ClientOptions,
): void {
  app.get('/api/v1/clients', async (request) => clients.list(userFromRequest(request).id))

  app.post('/api/v1/clients', async (request, reply) => {
    const user = userFromRequest(request)
    const result = validateDto(clientCreateBodySchema, request.body)
    if (!result.ok) return reply.code(422).send({ detail: '联系人请求字段无效' })
    return reply.code(201).send(await clients.create(user.id, result.value))
  })

  app.delete('/api/v1/clients/:clientId', async (request, reply) => {
    const user = userFromRequest(request)
    const rawId = (request.params as { clientId: string }).clientId
    if (!/^[+-]?\d+$/.test(rawId) || !Number.isSafeInteger(Number(rawId)))
      return reply.code(422).send({ detail: '联系人标识无效' })
    const clientId = Number(rawId)
    if (clientId <= 0) return reply.code(404).send({ detail: '联系人不存在' })
    await clients.delete(user.id, clientId)
    return reply.code(204).send()
  })
}
