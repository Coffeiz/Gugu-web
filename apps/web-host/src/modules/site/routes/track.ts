import type { FastifyInstance } from 'fastify'
import type { TrackOptions, UserFromRequest } from '../../../app.js'
import { validateDto } from '../../../http/dto.js'
import { trackBodySchema } from '../../../http/dtos.js'

export function registerTrackRoute(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  track: TrackOptions,
): void {
  app.post('/api/v1/track', async (request, reply) => {
    const user = userFromRequest(request)
    const result = validateDto(trackBodySchema, request.body)
    if (!result.ok) return reply.code(422).send({ detail: '埋点请求字段无效' })
    await track.track(user.id, result.value.event, result.value.properties)
    return { ok: true }
  })
}
