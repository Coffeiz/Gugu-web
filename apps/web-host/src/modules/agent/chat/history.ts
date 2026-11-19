import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { AgentMessagePageOptions } from './read.js'
import { createAgentSessionApplication, createPostgresAgentSessionRepository } from '@gugu/core/agent-sessions'
import type { Pool } from 'pg'

export interface AgentMessageHistoryRouteOptions {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  list(ownerId: string, sessionId: number, options: AgentMessagePageOptions): Promise<unknown>
}

function optionalInteger(value: unknown, label: string): number | null {
  if (value === undefined) return null
  const raw = Array.isArray(value) ? value.at(-1) : value
  if (typeof raw !== 'string' || !/^[+-]?\d+$/.test(raw)) throw new Error(`${label}无效`)
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label}无效`)
  return parsed
}

function optionalBoolean(value: unknown): boolean {
  if (value === undefined) return false
  const raw = Array.isArray(value) ? value.at(-1) : value
  if (typeof raw !== 'string') throw new Error('交互恢复参数无效')
  const normalized = raw.toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  throw new Error('交互恢复参数无效')
}

export function registerAgentMessageHistoryRoute(
  app: FastifyInstance,
  options: AgentMessageHistoryRouteOptions,
): void {
  app.get<{ Params: { session_id: string }; Querystring: Record<string, unknown> }>(
    '/api/v1/agent/sessions/:session_id/messages',
    { preHandler: options.requireUser },
    async (request, reply) => {
      const sessionIdRaw = request.params.session_id
      if (!/^[+-]?\d+$/.test(sessionIdRaw))
        return reply.code(422).send({ detail: '会话 ID 无效' })
      const sessionId = Number(sessionIdRaw)
      if (!Number.isSafeInteger(sessionId)) return reply.code(422).send({ detail: '会话 ID 无效' })

      let limit: number | null
      let beforeId: number | null
      let afterId: number | null
      let throughId: number | null
      let restoreInteractions: boolean
      try {
        limit = optionalInteger(request.query.limit, '分页数量')
        beforeId = optionalInteger(request.query.before_id, '消息 ID')
        afterId = optionalInteger(request.query.after_id, '消息 ID')
        throughId = optionalInteger(request.query.through_id, '消息 ID')
        restoreInteractions = optionalBoolean(request.query.restore_interactions)
      } catch (error) {
        return reply.code(422).send({ detail: error instanceof Error ? error.message : '分页参数无效' })
      }

      const runId = request.query.run_id
      if (runId !== undefined && typeof runId !== 'string')
        return reply.code(422).send({ detail: '运行 ID 无效' })
      return options.list(options.userIdFromRequest(request), sessionId, {
        limit: Math.min(200, Math.max(1, limit ?? 50)),
        ...(beforeId === null ? {} : { beforeId }),
        ...(afterId === null ? {} : { afterId }),
        ...(throughId === null ? {} : { throughId }),
        ...(runId === undefined ? {} : { runId }),
        restoreInteractions,
      })
    },
  )
}

export interface AgentMessageLocation {
  id: number
  sessionId: number
}

export interface AgentMessageLocationRouteOptions {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  locate(ownerId: string, messageId: number): Promise<AgentMessageLocation | null>
}

export function registerAgentMessageLocationRoute(
  app: FastifyInstance,
  options: AgentMessageLocationRouteOptions,
): void {
  app.get<{ Params: { message_id: string } }>(
    '/api/v1/agent/messages/:message_id',
    { preHandler: options.requireUser },
    async (request, reply) => {
      const rawMessageId = request.params.message_id
      if (!/^[+-]?\d+$/.test(rawMessageId))
        return reply.code(422).send({ detail: '消息 ID 无效' })
      const messageId = Number(rawMessageId)
      if (!Number.isSafeInteger(messageId)) return reply.code(422).send({ detail: '消息 ID 无效' })

      const location = await options.locate(options.userIdFromRequest(request), messageId)
      if (!location) return reply.code(404).send({ detail: '消息不存在' })
      return location
    },
  )
}

export function createPostgresAgentMessageLocator(pool: Pool) {
  const repository = createPostgresAgentSessionRepository(pool)
  return createAgentSessionApplication(repository).locate
}
