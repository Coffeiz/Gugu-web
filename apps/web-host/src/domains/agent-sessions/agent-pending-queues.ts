import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Pool } from 'pg'
import { createPostgresAgentPendingQueue, visiblePendingQueueItems } from '@gugu/core/agent-sessions'

export interface AgentPendingQueueSnapshot {
  sessionId: number | null
  items: unknown
  projected?: true
}

export interface AgentPendingQueueReadOptions {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  readQueue(ownerId: string, queueId: string): Promise<AgentPendingQueueSnapshot | null>
  nowSeconds?: () => number
}

export interface AgentImportedDraftQueue {
  queueId: string
  items: unknown
  projected?: true
}

export interface AgentImportedDraftQueueReadOptions {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  readImportedDrafts(ownerId: string): Promise<AgentImportedDraftQueue[]>
  nowSeconds?: () => number
}

function visibleQueueItems(queueId: string, sessionId: number | null, items: unknown, now: number, projected = false) {
  return visiblePendingQueueItems(queueId, sessionId, items, now, projected)
}

export function registerAgentPendingQueueReadRoute(
  app: FastifyInstance,
  options: AgentPendingQueueReadOptions,
): void {
  app.get<{ Params: { queue_id: string } }>(
    '/api/v1/agent/pending-queues/:queue_id',
    { preHandler: options.requireUser },
    async (request, reply) => {
      const { queue_id: queueId } = request.params
      if (queueId.length < 1 || queueId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(queueId))
        return reply.code(422).send({ detail: '队列标识无效' })

      const ownerId = options.userIdFromRequest(request)
      const queue = await options.readQueue(ownerId, queueId)
      const sessionId = queue?.sessionId ?? null
      return {
        sessionId,
        items: visibleQueueItems(queueId, sessionId, queue?.items, (options.nowSeconds ?? (() => Date.now() / 1000))(), queue?.projected),
      }
    },
  )
}

export function registerAgentImportedDraftQueueRoute(
  app: FastifyInstance,
  options: AgentImportedDraftQueueReadOptions,
): void {
  app.get('/api/v1/agent/pending-queues/imported-drafts',
    { preHandler: options.requireUser },
    async (request) => {
      const drafts = await options.readImportedDrafts(options.userIdFromRequest(request))
      const now = (options.nowSeconds ?? (() => Date.now() / 1000))()
      return {
        queues: drafts.flatMap((draft) => {
          const items = visibleQueueItems(draft.queueId, null, draft.items, now, draft.projected)
          return items.length ? [{ queue_id: draft.queueId, items }] : []
        }),
      }
    },
  )
}

export function createPostgresAgentPendingQueueReader(pool: Pick<Pool, 'query'>) {
  return createPostgresAgentPendingQueue(pool as Pool, {}).readQueue
}

export function createPostgresAgentImportedDraftQueueReader(pool: Pick<Pool, 'query'>) {
  return createPostgresAgentPendingQueue(pool as Pool, {}).readImportedDrafts
}
