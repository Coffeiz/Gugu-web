import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Pool } from 'pg'
import { createPostgresAgentPendingQueue, QueueSessionNotFound as AgentPendingQueueSessionNotFoundError, QueueConflict as AgentPendingQueueConflictError } from '@gugu/core/agent-sessions'
export { AgentPendingQueueSessionNotFoundError, AgentPendingQueueConflictError }

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

export function createPostgresAgentPendingQueueClaims(
  pool: Pick<Pool, 'query' | 'connect'>,
  options: Pick<Parameters<typeof createPostgresAgentPendingQueue>[1], 'isSessionActive' | 'nowSeconds' | 'createToken'>,
) {
  const service = createPostgresAgentPendingQueue(pool, options)
  return { claim: service.claim, release: service.release }
}
