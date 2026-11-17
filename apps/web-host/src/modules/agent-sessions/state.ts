import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { Pool } from 'pg'
import { createAgentSessionStateReader, type AgentSessionStatePorts } from '@gugu/core/agent-sessions'

export interface AgentSessionStateRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: import('fastify').FastifyRequest): string
  readState(ownerId: string, sessionId: number): Promise<{
    executionState: string
    pendingMessageCount: number
    active: boolean
  } | null>
}

export function createPostgresAgentSessionStateReader(
  pool: Pick<Pool, 'query'>,
  runtime: Pick<AgentSessionStatePorts, 'recover' | 'isActive'>,
) {
  return createAgentSessionStateReader({
    ...runtime,
    async read(ownerId, sessionId) {
      const result = await pool.query<{ execution_state: string; pending_message_count: number | string | null }>(
        `SELECT execution_state, pending_message_count
         FROM conversation_sessions WHERE user_id=$1 AND id=$2`,
        [ownerId, sessionId],
      )
      const row = result.rows[0]
      return row ? {
        executionState: row.execution_state,
        pendingMessageCount: Number(row.pending_message_count ?? 0),
      } : null
    },
  })
}

export function registerAgentSessionStateRoute(app: FastifyInstance, options: AgentSessionStateRouteOptions): void {
  app.get<{ Params: { session_id: string } }>('/api/v1/agent/sessions/:session_id/state', {
    preHandler: options.requireUser,
  }, async (request, reply) => {
    if (!/^[1-9]\d*$/.test(request.params.session_id)) return reply.code(422).send({ detail: '会话 ID 无效' })
    const sessionId = Number(request.params.session_id)
    if (!Number.isSafeInteger(sessionId)) return reply.code(422).send({ detail: '会话 ID 无效' })
    const result = await options.readState(options.ownerIdFromRequest(request), sessionId)
    if (!result) return reply.code(404).send({ detail: '对话不存在' })
    return result
  })
}
