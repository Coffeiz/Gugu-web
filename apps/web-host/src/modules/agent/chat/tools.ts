import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { sanitizeMediaPayload } from '@gugu/core/agent/context/messages'
import { AgentToolEventSessionNotFoundError, AgentToolEventDetailsNotFoundError, createPostgresAgentToolEventDetails } from '@gugu/core/agent-sessions'
import type { Pool } from 'pg'

export { AgentToolEventSessionNotFoundError, AgentToolEventDetailsNotFoundError, createPostgresAgentToolEventDetails }

export interface AgentToolEventDetailsRouteOptions {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  readDetails(ownerId: string, sessionId: number, messageId: number, timelineIndex: number): Promise<unknown | null>
}

export function registerAgentToolEventDetailsRoute(
  app: FastifyInstance,
  options: AgentToolEventDetailsRouteOptions,
): void {
  app.get<{ Params: { session_id: string }; Querystring: {
    source?: string; message_id?: string; timeline_index?: string
  } }>(
    '/api/v1/agent/sessions/:session_id/tool-event-details',
    { preHandler: options.requireUser },
    async (request, reply) => {
      const sessionId = Number(request.params.session_id)
      if (!Number.isSafeInteger(sessionId)) return reply.code(422).send({ detail: '会话 ID 无效' })
      const { source, message_id: rawMessageId, timeline_index: rawIndex } = request.query
      if (source !== 'timeline') return reply.code(422).send({ detail: 'source 必须为 timeline' })
      if (rawMessageId === undefined || rawIndex === undefined)
        return reply.code(400).send({ detail: '工具事件标识无效' })
      const messageId = Number(rawMessageId), timelineIndex = Number(rawIndex)
      if (!Number.isSafeInteger(messageId) || !Number.isSafeInteger(timelineIndex) || timelineIndex < 0)
        return reply.code(422).send({ detail: '工具事件标识无效' })
      try {
        const details = await options.readDetails(
          options.userIdFromRequest(request), sessionId, messageId, timelineIndex,
        )
        if (details === null) return reply.code(404).send({ detail: '工具事件不存在' })
        return sanitizeMediaPayload(details)
      } catch (error) {
        if (error instanceof AgentToolEventSessionNotFoundError)
          return reply.code(404).send({ detail: '对话不存在' })
        if (error instanceof AgentToolEventDetailsNotFoundError)
          return reply.code(404).send({ detail: '工具事件不存在' })
        throw error
      }
    },
  )
}

export interface AgentSessionToolEventDetailsRouteOptions {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  pool: Pick<Pool, 'query' | 'connect'>
}

export function registerAgentSessionToolEventDetailsRoute(
  app: FastifyInstance,
  options: AgentSessionToolEventDetailsRouteOptions,
): void {
  registerAgentToolEventDetailsRoute(app, {
    requireUser: options.requireUser,
    userIdFromRequest: options.userIdFromRequest,
    readDetails: createPostgresAgentToolEventDetails(options.pool),
  })
}
