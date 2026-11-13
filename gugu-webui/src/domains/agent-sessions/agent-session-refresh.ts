import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Pool } from 'pg'

export interface RefreshedAgentSession {
  id: number
  context_epoch: number
}

export interface AgentSessionRefreshEvent {
  sessionId: number
  contextEpoch: number
  snapshotHash: string | null
  sessionInfoHash: string | null
  expiresAt: string
}

export interface AgentSessionRefreshRouteOptions {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  refresh(ownerId: string, sessionId: number): Promise<RefreshedAgentSession | null>
}

export function registerAgentSessionRefreshRoute(
  app: FastifyInstance,
  options: AgentSessionRefreshRouteOptions,
): void {
  app.post<{ Params: { session_id: string } }>(
    '/api/v1/agent/sessions/:session_id/refresh-context',
    { preHandler: options.requireUser },
    async (request, reply) => {
      const rawSessionId = request.params.session_id
      if (!/^[+-]?\d+$/.test(rawSessionId))
        return reply.code(422).send({ detail: '会话 ID 无效' })
      const sessionId = Number(rawSessionId)
      if (!Number.isSafeInteger(sessionId)) return reply.code(422).send({ detail: '会话 ID 无效' })

      const refreshed = await options.refresh(options.userIdFromRequest(request), sessionId)
      if (!refreshed) return reply.code(404).send({ detail: '会话不存在' })
      return { ...refreshed, refresh_scheduled: true }
    },
  )
}

interface SnapshotSessionRow extends RefreshedAgentSession {
  snapshot_hash: string | null
  session_info_hash: string | null
  snapshot_expires_at: Date
}

export function createPostgresAgentSessionRefresher(
  pool: Pool,
  recordInvalidation: (event: AgentSessionRefreshEvent) => Promise<void> | void = () => undefined,
) {
  return async function refreshAgentSession(
    ownerId: string,
    sessionId: number,
  ): Promise<RefreshedAgentSession | null> {
    const result = await pool.query<SnapshotSessionRow>(
      `UPDATE conversation_sessions
       SET snapshot_expires_at = now(),
           context_epoch = COALESCE(context_epoch, 0) + 1,
           updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING id, context_epoch, snapshot_hash, session_info_hash, snapshot_expires_at`,
      [sessionId, ownerId],
    )
    const row = result.rows[0]
    if (!row) return null

    try {
      await recordInvalidation({
        sessionId: row.id,
        contextEpoch: row.context_epoch,
        snapshotHash: row.snapshot_hash,
        sessionInfoHash: row.session_info_hash,
        expiresAt: row.snapshot_expires_at.toISOString(),
      })
    } catch {
      // Python 的 trace 写入是 best-effort，不应改变快照失效的主结果。
    }
    return { id: row.id, context_epoch: row.context_epoch }
  }
}
