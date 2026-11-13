import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Pool } from 'pg'

export interface AgentMessageLocation {
  id: number
  sessionId: number
}

export interface AgentMessageLocationRouteOptions {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  locate(ownerId: string, messageId: number): Promise<AgentMessageLocation | null>
}

export function registerAgentMessageLocationRoute(
  app: FastifyInstance,
  options: AgentMessageLocationRouteOptions,
): void {
  app.get<{ Params: { message_id: string } }>(
    '/api/v1/agent/messages/:message_id',
    { preHandler: options.requireUser },
    async (request, reply) => {
      const rawMessageId = request.params.message_id
      if (!/^[+-]?\d+$/.test(rawMessageId))
        return reply.code(422).send({ detail: '消息 ID 无效' })
      const messageId = Number(rawMessageId)
      if (!Number.isSafeInteger(messageId)) return reply.code(422).send({ detail: '消息 ID 无效' })

      const location = await options.locate(options.userIdFromRequest(request), messageId)
      if (!location) return reply.code(404).send({ detail: '消息不存在' })
      return location
    },
  )
}

export function createPostgresAgentMessageLocator(pool: Pool) {
  return async function locateAgentMessage(
    ownerId: string,
    messageId: number,
  ): Promise<AgentMessageLocation | null> {
    const result = await pool.query<AgentMessageLocation>(
      `SELECT message.id, message.session_id AS "sessionId"
       FROM conversation_messages AS message
       JOIN conversation_sessions AS session ON session.id = message.session_id
       WHERE message.id = $1 AND session.user_id = $2
         AND message.content_json IS NULL AND message.role <> 'summary'`,
      [messageId, ownerId],
    )
    return result.rows[0] ?? null
  }
}
