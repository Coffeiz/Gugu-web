import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Pool } from 'pg'
import { sanitizeMediaPayload } from './media-payload.js'

export class AgentToolEventSessionNotFoundError extends Error {
  readonly statusCode = 404
  constructor() { super('对话不存在') }
}

export class AgentToolEventDetailsNotFoundError extends Error {
  readonly statusCode = 404
  constructor() { super('工具事件不存在') }
}

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

interface TimelineRecord { display_timeline: unknown }

export function createPostgresAgentToolEventDetails(pool: Pick<Pool, 'query'>) {
  return async function readDetails(
    ownerId: string,
    sessionId: number,
    messageId: number,
    timelineIndex: number,
  ): Promise<Record<string, unknown>> {
    const owned = await pool.query(
      'SELECT id FROM conversation_sessions WHERE id = $1 AND user_id = $2',
      [sessionId, ownerId],
    )
    if (!owned.rowCount) throw new AgentToolEventSessionNotFoundError()

    const result = await pool.query<TimelineRecord>(
      `SELECT CASE WHEN pg_column_size(display_timeline) > 1048576 THEN NULL
                   ELSE display_timeline END AS display_timeline
       FROM conversation_messages WHERE id = $1 AND session_id = $2`,
      [messageId, sessionId],
    )
    const timeline = result.rows[0]?.display_timeline
    if (!Array.isArray(timeline) || timelineIndex >= timeline.length)
      throw new AgentToolEventDetailsNotFoundError()
    const event = timeline[timelineIndex]
    if (!event || typeof event !== 'object' || Array.isArray(event) || (event as Record<string, unknown>).kind !== 'tool')
      throw new AgentToolEventDetailsNotFoundError()
    const details: Record<string, unknown> = {}
    for (const key of ['toolInput', 'toolResult'])
      if (key in event) details[key] = (event as Record<string, unknown>)[key]
    return details
  }
}
