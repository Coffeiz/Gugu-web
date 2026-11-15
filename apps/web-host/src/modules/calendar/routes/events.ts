import type { FastifyInstance } from 'fastify'
import type { RequestContext } from '@gugu/core'
import type { EventOptions, UserFromRequest, WriteRequestMetadata } from '../../../app.js'
import { parsePythonInteger, writeRequestMetadata } from '../../../http/request.js'

export interface EventUpdateRouteOptions {
  update?: (
    context: RequestContext,
    eventId: number,
    body: unknown,
    metadata: WriteRequestMetadata,
  ) => Promise<unknown>
}

export function registerEventRoutes(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  events: EventOptions & EventUpdateRouteOptions,
): void {
  if (events.create) {
    app.post('/api/v1/events', async (request, reply) => {
      const user = userFromRequest(request)
      return reply.code(201).send(await events.create!(
        user.requestContext,
        request.body,
        writeRequestMetadata(request),
      ))
    })
  }

  if (events.delete) {
    app.delete('/api/v1/events/:eventId', async (request, reply) => {
      const user = userFromRequest(request)
      const rawId = (request.params as { eventId: string }).eventId
      const eventId = parsePythonInteger(rawId)
      const version = parsePythonInteger((request.query as Record<string, unknown>).version)
      if (eventId === undefined || eventId === null || version === undefined || version === null)
        return reply.code(422).send({ detail: '事件标识或版本无效' })
      await events.delete!(user.requestContext, eventId, version, writeRequestMetadata(request))
      return reply.code(204).send()
    })
  }

  if (events.update) {
    app.patch('/api/v1/events/:eventId', async (request, reply) => {
      const user = userFromRequest(request)
      const rawId = (request.params as { eventId: string }).eventId
      const eventId = parsePythonInteger(rawId)
      if (eventId === undefined || eventId === null)
        return reply.code(422).send({ detail: '事件标识无效' })
      return events.update!(
        user.requestContext,
        eventId,
        request.body,
        writeRequestMetadata(request),
      )
    })
  }

  app.get('/api/v1/events', async (request, reply) => {
    const user = userFromRequest(request)
    const query = request.query as Record<string, unknown>
    const year = parsePythonInteger(query.year)
    const month = parsePythonInteger(query.month)
    if (year === null || month === null)
      return reply.code(422).send({ detail: '年份或月份无效' })
    return events.list(user.id, year, month)
  })

  app.get('/api/v1/events/:eventId', async (request, reply) => {
    const user = userFromRequest(request)
    const rawId = (request.params as { eventId: string }).eventId
    const eventId = parsePythonInteger(rawId)
    if (eventId === undefined || eventId === null)
      return reply.code(422).send({ detail: '事件标识无效' })
    const event = await events.get(user.id, eventId)
    if (event === null) return reply.code(404).send({ detail: '事件不存在' })
    return event
  })
}
