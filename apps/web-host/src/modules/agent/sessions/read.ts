import { createPostgresAgentSessionLister, type AgentSessionListRuntime } from '@gugu/core/agent-sessions'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Pool } from 'pg'
import { createAgentSessionStateReader, type AgentSessionStatePorts } from '@gugu/core/agent-sessions'

export interface AgentSessionRouteOptions {
  /** Host authentication hook; it must reject before the identity accessor or store runs. */
  requireUser: preHandlerHookHandler
  /** Reads the authenticated RequestContext created by the Host, never request input. */
  userIdFromRequest(request: FastifyRequest): string
  list(ownerId: string): Promise<unknown[]>
}

export function registerAgentSessionRoute(app: FastifyInstance, options: AgentSessionRouteOptions): void {
  app.get('/api/v1/agent/sessions', { preHandler: options.requireUser }, async (request) =>
    options.list(options.userIdFromRequest(request)),
  )
}

export type AgentSessionRuntime = AgentSessionListRuntime

/** HTTP 身份与运行能力仍由 Host 提供；业务列表由 Core 处理。 */
export function createAgentSessionLister(pool: Pool, runtime: AgentSessionRuntime) {
  return createPostgresAgentSessionLister(pool, runtime)
}

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
