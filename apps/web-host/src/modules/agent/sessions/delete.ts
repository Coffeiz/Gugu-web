import { createAgentSessionDeleter } from '@gugu/core/agent-sessions'
import { createPostgresAgentSessionDeleteRepository } from '@gugu/core/agent-sessions'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Pool } from 'pg'

export interface AgentSessionDeleteOperations {
  remove(ownerId: string, sessionId: number): Promise<boolean>
}

export function registerAgentSessionDeleteRoute(app: FastifyInstance, options: {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  operations: AgentSessionDeleteOperations
}): void {
  app.delete<{ Params: { session_id: string } }>('/api/v1/agent/sessions/:session_id', {
    preHandler: options.requireUser,
  }, async (request, reply) => {
    if (!/^[+-]?\d+$/.test(request.params.session_id))
      return reply.code(422).send({ detail: '会话 ID 无效' })
    const sessionId = Number(request.params.session_id)
    if (!Number.isSafeInteger(sessionId)) return reply.code(422).send({ detail: '会话 ID 无效' })
    if (sessionId < 1) return reply.code(404).send({ detail: '对话不存在' })
    if (!await options.operations.remove(options.userIdFromRequest(request), sessionId))
      return reply.code(404).send({ detail: '对话不存在' })
    return reply.code(204).send()
  })
}

export function createPostgresAgentSessionDeleteOperations(pool: Pool, ports: {
  removeIfUnreferenced(ownerId: string, storageKey: string): Promise<boolean>
  clearReflection(ownerId: string, sessionId: number): Promise<void>
}): AgentSessionDeleteOperations {
  return { remove: createAgentSessionDeleter(createPostgresAgentSessionDeleteRepository(pool), ports) }
}
