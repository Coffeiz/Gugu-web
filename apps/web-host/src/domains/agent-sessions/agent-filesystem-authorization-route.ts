import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { AgentFilesystemAuthorizationError } from './agent-filesystem-authorization.js'

export interface AgentFilesystemAuthorizationOperations {
  request(ownerId: string, sessionId: number): Promise<unknown>
  confirm(ownerId: string, sessionId: number, confirmCode: string): Promise<unknown>
  revoke(ownerId: string, sessionId: number): Promise<unknown>
}

export interface AgentFilesystemAuthorizationRouteOptions {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  operations: AgentFilesystemAuthorizationOperations
}

function parseSessionId(value: string): number | null {
  if (!/^[+-]?\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function parseConfirmationCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim()
  return code.length > 0 && [...code].length <= 128 ? code : null
}

async function runOperation(
  reply: FastifyReply,
  operation: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof AgentFilesystemAuthorizationError && error.statusCode === 503)
      return reply.code(503).send({ detail: error.message })
    throw error
  }
}

/** 会话沙箱授权必须由已认证的所有者提交一次性确认码。 */
export function registerAgentFilesystemAuthorizationRoutes(
  app: FastifyInstance,
  options: AgentFilesystemAuthorizationRouteOptions,
): void {
  const routeOptions = { preHandler: options.requireUser }
  app.post<{ Params: { session_id: string } }>(
    '/api/v1/agent/sessions/:session_id/filesystem-authorization/request',
    routeOptions,
    async (request, reply) => {
      const sessionId = parseSessionId(request.params.session_id)
      if (sessionId === null) return reply.code(422).send({ detail: '会话 ID 无效' })
      return runOperation(reply, () => options.operations.request(options.userIdFromRequest(request), sessionId))
    },
  )

  app.post<{ Params: { session_id: string }; Body: { confirm_code?: unknown } }>(
    '/api/v1/agent/sessions/:session_id/filesystem-authorization',
    routeOptions,
    async (request, reply) => {
      const sessionId = parseSessionId(request.params.session_id)
      if (sessionId === null) return reply.code(422).send({ detail: '会话 ID 无效' })
      const confirmCode = parseConfirmationCode(request.body?.confirm_code)
      if (!confirmCode) return reply.code(422).send({ detail: '授权确认码无效' })
      return runOperation(reply, () => options.operations.confirm(
        options.userIdFromRequest(request), sessionId, confirmCode,
      ))
    },
  )

  app.delete<{ Params: { session_id: string } }>(
    '/api/v1/agent/sessions/:session_id/filesystem-authorization',
    routeOptions,
    async (request, reply) => {
      const sessionId = parseSessionId(request.params.session_id)
      if (sessionId === null) return reply.code(422).send({ detail: '会话 ID 无效' })
      return runOperation(reply, () => options.operations.revoke(options.userIdFromRequest(request), sessionId))
    },
  )
}
