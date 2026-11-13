import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Pool } from 'pg'

export interface AgentPendingQueueSnapshot {
  sessionId: number | null
  items: unknown
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
}

export interface AgentImportedDraftQueueReadOptions {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  readImportedDrafts(ownerId: string): Promise<AgentImportedDraftQueue[]>
  nowSeconds?: () => number
}

function visibleQueueItems(queueId: string, sessionId: number | null, items: unknown, now: number) {
  if (!Array.isArray(items)) return []
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    const { _claim_token: claimToken, _claim_until: claimUntil, ...visible } = record
    return [{
      ...visible,
      queue_id: queueId,
      session_id: sessionId,
      claimed: Boolean(claimToken && typeof claimUntil === 'number' && claimUntil > now),
    }]
  })
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
        items: visibleQueueItems(queueId, sessionId, queue?.items, (options.nowSeconds ?? (() => Date.now() / 1000))()),
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
          const items = visibleQueueItems(draft.queueId, null, draft.items, now)
          return items.length ? [{ queue_id: draft.queueId, items }] : []
        }),
      }
    },
  )
}

export function createPostgresAgentPendingQueueReader(pool: Pick<Pool, 'query'>) {
  return async function readQueue(ownerId: string, queueId: string): Promise<AgentPendingQueueSnapshot | null> {
    const result = await pool.query<{ session_id: number | null; items: unknown }>(
      `SELECT session_id, items
       FROM conversation_pending_queues
       WHERE user_id = $1 AND queue_id = $2
       LIMIT 1`,
      [ownerId, queueId],
    )
    const row = result.rows[0]
    return row ? { sessionId: row.session_id, items: row.items } : null
  }
}

export function createPostgresAgentImportedDraftQueueReader(pool: Pick<Pool, 'query'>) {
  return async function readImportedDrafts(ownerId: string): Promise<AgentImportedDraftQueue[]> {
    const result = await pool.query<{ queue_id: string; items: unknown }>(
      `SELECT queue_id, items
       FROM conversation_pending_queues
       WHERE user_id = $1 AND session_id IS NULL AND queue_id LIKE 'import-%'
       ORDER BY updated_at, id`,
      [ownerId],
    )
    return result.rows.map((row) => ({ queueId: row.queue_id, items: row.items }))
  }
}
