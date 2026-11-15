import { createAgentSessionApplication, createPostgresAgentSessionRepository, normalizeAgentSessionTitle } from '@gugu/core/agent-sessions'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Pool } from 'pg'

export interface RenamedAgentSession {
  id: number
  title: string
  title_locked: boolean
}

export interface AgentSessionRenameRouteOptions {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  rename(ownerId: string, sessionId: number, title: string): Promise<RenamedAgentSession | null>
}

export function registerAgentSessionRenameRoute(
  app: FastifyInstance,
  options: AgentSessionRenameRouteOptions,
): void {
  app.patch<{ Params: { session_id: string }; Body: { title?: unknown } }>(
    '/api/v1/agent/sessions/:session_id',
    { preHandler: options.requireUser },
    async (request, reply) => {
      const rawSessionId = request.params.session_id
      if (!/^[+-]?\d+$/.test(rawSessionId))
        return reply.code(422).send({ detail: '会话 ID 无效' })
      const sessionId = Number(rawSessionId)
      if (!Number.isSafeInteger(sessionId)) return reply.code(422).send({ detail: '会话 ID 无效' })

      let title: string
      try { title = normalizeAgentSessionTitle(request.body?.title) }
      catch (error) { return reply.code(422).send({ detail: error instanceof Error ? error.message : '标题无效' }) }

      const renamed = await options.rename(options.userIdFromRequest(request), sessionId, title)
      if (!renamed) return reply.code(404).send({ detail: '对话不存在' })
      return renamed
    },
  )
}

export function createPostgresAgentSessionRenamer(pool: Pool) {
  const repository = createPostgresAgentSessionRepository(pool)
  return createAgentSessionApplication(repository).rename
}
