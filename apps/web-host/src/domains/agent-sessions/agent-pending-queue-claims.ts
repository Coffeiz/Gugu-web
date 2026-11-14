import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../adapters/postgres-transaction.js'

export class AgentPendingQueueSessionNotFoundError extends Error {
  readonly statusCode = 404
  constructor() { super('对话不存在') }
}

export class AgentPendingQueueConflictError extends Error {
  readonly statusCode = 409
  constructor() { super('队列标识与会话不一致') }
}

export interface AgentPendingQueueClaimRouteOptions {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  claim(ownerId: string, sessionId: number, queueId: string, itemKey: number): Promise<{
    claimToken: string | null; reason?: 'session_active'
  }>
  release(ownerId: string, sessionId: number, queueId: string, itemKey: number, claimToken: string): Promise<boolean>
  publishChanged(ownerId: string, sessionId: number, origin?: string): Promise<void>
}

const pathIdPattern = /^[A-Za-z0-9_-]+$/

function parsePositiveInt(value: string): number | null {
  if (!/^\+?\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function registerAgentPendingQueueClaimRoutes(
  app: FastifyInstance,
  options: AgentPendingQueueClaimRouteOptions,
): void {
  const common = { preHandler: options.requireUser }
  app.post<{ Params: { queue_id: string; item_key: string }; Body: { session_id?: number } }>(
    '/api/v1/agent/pending-queues/:queue_id/items/:item_key/claim', common,
    async (request, reply) => {
      const queueId = request.params.queue_id
      const sessionId = Number(request.body?.session_id)
      const itemKey = parsePositiveInt(request.params.item_key)
      const bodyKeys = Object.keys(request.body ?? {})
      if (!queueId || queueId.length > 64 || !pathIdPattern.test(queueId))
        return reply.code(422).send({ detail: '队列标识无效' })
      if (bodyKeys.some((key) => key !== 'session_id')
        || !Number.isSafeInteger(sessionId) || sessionId < 1 || !itemKey)
        return reply.code(422).send({ detail: '认领参数无效' })
      try {
        const result = await options.claim(options.userIdFromRequest(request), sessionId, queueId, itemKey)
        return result.reason === 'session_active'
          ? { claim_token: null, reason: result.reason }
          : { claim_token: result.claimToken }
      } catch (error) {
        if (error instanceof AgentPendingQueueSessionNotFoundError)
          return reply.code(404).send({ detail: '对话不存在' })
        if (error instanceof AgentPendingQueueConflictError)
          return reply.code(409).send({ detail: error.message })
        throw error
      }
    },
  )

  app.post<{ Params: { queue_id: string; item_key: string }; Body: { session_id?: number; claim_token?: string } }>(
    '/api/v1/agent/pending-queues/:queue_id/items/:item_key/release', common,
    async (request, reply) => {
      const queueId = request.params.queue_id
      const sessionId = Number(request.body?.session_id)
      const itemKey = parsePositiveInt(request.params.item_key)
      const claimToken = request.body?.claim_token
      const bodyKeys = Object.keys(request.body ?? {})
      if (!queueId || queueId.length > 64 || !pathIdPattern.test(queueId))
        return reply.code(422).send({ detail: '队列标识无效' })
      if (bodyKeys.some((key) => key !== 'session_id' && key !== 'claim_token')
        || !Number.isSafeInteger(sessionId) || sessionId < 1 || !itemKey
        || typeof claimToken !== 'string' || claimToken.length < 1 || claimToken.length > 128)
        return reply.code(422).send({ detail: '释放参数无效' })
      try {
        const ownerId = options.userIdFromRequest(request)
        const released = await options.release(ownerId, sessionId, queueId, itemKey, claimToken)
        if (released) {
          const origin = request.headers['x-client-id']
          await options.publishChanged(ownerId, sessionId, typeof origin === 'string' ? origin : undefined)
        }
        return { released }
      } catch (error) {
        if (error instanceof AgentPendingQueueSessionNotFoundError)
          return reply.code(404).send({ detail: '对话不存在' })
        if (error instanceof AgentPendingQueueConflictError)
          return reply.code(409).send({ detail: error.message })
        throw error
      }
    },
  )
}

interface QueueRow { session_id: number | null; items: unknown }

function isActiveClaim(item: Record<string, unknown>, now: number): boolean {
  return Boolean(item._claim_token)
    && typeof item._claim_until === 'number'
    && item._claim_until > now
}

function tokensMatch(stored: unknown, candidate: string): boolean {
  if (typeof stored !== 'string') return false
  const left = Buffer.from(stored), right = Buffer.from(candidate)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function createPostgresAgentPendingQueueClaims(
  pool: Pick<Pool, 'query' | 'connect'>,
  options: {
    isSessionActive(sessionId: number): Promise<boolean>
    nowSeconds?: () => number
    createToken?: () => string
  },
) {
  const nowSeconds = options.nowSeconds ?? (() => Date.now() / 1000)
  const createToken = options.createToken ?? (() => randomBytes(32).toString('base64url'))

  async function assertOwnedSession(ownerId: string, sessionId: number, queueId: string): Promise<void> {
    const session = await pool.query(
      'SELECT id FROM conversation_sessions WHERE id = $1 AND user_id = $2', [sessionId, ownerId],
    )
    if (!session.rowCount) throw new AgentPendingQueueSessionNotFoundError()
    if (queueId !== `session-${sessionId}`) throw new AgentPendingQueueConflictError()
  }

  async function lockQueue(client: PoolClient, ownerId: string, sessionId: number, queueId: string) {
    const result = await client.query<QueueRow>(
      `SELECT session_id, items FROM conversation_pending_queues
       WHERE user_id = $1 AND queue_id = $2 FOR UPDATE`, [ownerId, queueId],
    )
    const row = result.rows[0]
    return row?.session_id === sessionId ? row : null
  }

  return {
    async claim(ownerId: string, sessionId: number, queueId: string, itemKey: number) {
      await assertOwnedSession(ownerId, sessionId, queueId)
      if (await options.isSessionActive(sessionId)) return { claimToken: null, reason: 'session_active' as const }
      return withPostgresTransaction(pool, async (client) => {
        const row = await lockQueue(client, ownerId, sessionId, queueId)
        const items = Array.isArray(row?.items) ? row.items : []
        const item = items.find((entry) => !!entry && typeof entry === 'object'
          && (entry as Record<string, unknown>).key === itemKey) as Record<string, unknown> | undefined
        if (!item || isActiveClaim(item, nowSeconds())) return { claimToken: null }
        const claimToken = createToken()
        const updated = items.map((entry) => entry === item
          ? { ...item, _claim_token: claimToken, _claim_until: nowSeconds() + 60 }
          : entry)
        await client.query(
          `UPDATE conversation_pending_queues SET items = $1::jsonb, updated_at = now()
           WHERE user_id = $2 AND queue_id = $3`, [JSON.stringify(updated), ownerId, queueId],
        )
        return { claimToken }
      })
    },

    async release(ownerId: string, sessionId: number, queueId: string, itemKey: number, claimToken: string) {
      await assertOwnedSession(ownerId, sessionId, queueId)
      return withPostgresTransaction(pool, async (client) => {
        const row = await lockQueue(client, ownerId, sessionId, queueId)
        const items = Array.isArray(row?.items) ? row.items : []
        const index = items.findIndex((entry) => !!entry && typeof entry === 'object'
          && (entry as Record<string, unknown>).key === itemKey
          && tokensMatch((entry as Record<string, unknown>)._claim_token, claimToken))
        if (index < 0) return false
        const updated = [...items]
        const item = updated[index] as Record<string, unknown>
        updated[index] = Object.fromEntries(Object.entries(item)
          .filter(([key]) => key !== '_claim_token' && key !== '_claim_until'))
        await client.query(
          `UPDATE conversation_pending_queues SET items = $1::jsonb, updated_at = now()
           WHERE user_id = $2 AND queue_id = $3`, [JSON.stringify(updated), ownerId, queueId],
        )
        return true
      })
    },
  }
}
