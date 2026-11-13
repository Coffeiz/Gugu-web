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

      const value = request.body?.title
      if (typeof value !== 'string')
        return reply.code(422).send({ detail: '标题必须为文本' })
      const title = value.trim()
      if (!title) return reply.code(422).send({ detail: '标题不能为空' })
      // Python len(str) counts Unicode code points; JS string.length counts UTF-16 units.
      if ([...title].length > 300) return reply.code(422).send({ detail: '标题过长' })

      const renamed = await options.rename(options.userIdFromRequest(request), sessionId, title)
      if (!renamed) return reply.code(404).send({ detail: '对话不存在' })
      return renamed
    },
  )
}

export function createPostgresAgentSessionRenamer(pool: Pool) {
  return async function renameAgentSession(
    ownerId: string,
    sessionId: number,
    title: string,
  ): Promise<RenamedAgentSession | null> {
    const result = await pool.query<RenamedAgentSession>(
      `UPDATE conversation_sessions
       SET title = $1, title_locked = true
       WHERE id = $2 AND user_id = $3
       RETURNING id, title, title_locked`,
      [title, sessionId, ownerId],
    )
    return result.rows[0] ?? null
  }
}
