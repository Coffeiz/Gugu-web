import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { InteractionNotFoundError } from './persistence/agent-interaction-session.js'

export interface AgentInteractionSessionRouteOptions {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  lookup(ownerId: string, promptId: number): Promise<{ session_id: number }>
}

export function registerAgentInteractionSessionRoute(
  app: FastifyInstance,
  options: AgentInteractionSessionRouteOptions,
): void {
  app.get<{ Params: { prompt_id: string } }>(
    '/api/v1/agent/interactions/:prompt_id/session',
    { preHandler: options.requireUser },
    async (request, reply) => {
      const rawPromptId = request.params.prompt_id
      if (!/^[+-]?\d+$/.test(rawPromptId))
        return reply.code(422).send({ detail: '交互 ID 无效' })
      const promptId = Number(rawPromptId)
      if (!Number.isSafeInteger(promptId))
        return reply.code(422).send({ detail: '交互 ID 无效' })
      try {
        return await options.lookup(options.userIdFromRequest(request), promptId)
      } catch (error) {
        if (error instanceof InteractionNotFoundError)
          return reply.code(404).send({ detail: '交互不存在' })
        throw error
      }
    },
  )
}
