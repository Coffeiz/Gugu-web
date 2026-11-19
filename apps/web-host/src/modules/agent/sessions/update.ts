import { createAgentSessionApplication, createPostgresAgentSessionRepository, normalizeAgentSessionTitle } from '@gugu/core/agent-sessions'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Pool } from 'pg'
import { createAgentSessionRefresh, createPostgresAgentSessionRefreshRepository, type SessionRefreshResult } from '@gugu/core/agent-sessions'

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

/** trace 在 Core 事务提交后发出，观测故障不影响刷新结果。 */
export function createAgentSessionRefresher(
  refresh: (ownerId: string, sessionId: number) => Promise<SessionRefreshResult | null>,
  recordInvalidation: (event: AgentSessionRefreshEvent) => Promise<void> | void = () => undefined,
) {
  return async function refreshAgentSession(
    ownerId: string,
    sessionId: number,
  ): Promise<RefreshedAgentSession | null> {
    const row = await refresh(ownerId, sessionId)
    if (!row) return null

    try {
      await recordInvalidation({
        sessionId: row.id,
        contextEpoch: row.contextEpoch,
        snapshotHash: row.snapshotHash,
        sessionInfoHash: row.sessionInfoHash,
        expiresAt: new Date(row.expiresAt).toISOString(),
      })
    } catch {
      // Python 的 trace 写入是 best-effort，不应改变快照失效的主结果。
    }
    return { id: row.id, context_epoch: row.contextEpoch }
  }
}

export function createPostgresAgentSessionRefresher(pool: Pool, recordInvalidation?: (event: AgentSessionRefreshEvent) => Promise<void> | void) {
  const refresh = createAgentSessionRefresh(createPostgresAgentSessionRefreshRepository(pool))
  return createAgentSessionRefresher(refresh, recordInvalidation)
}
