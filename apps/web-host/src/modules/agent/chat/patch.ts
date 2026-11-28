import { z } from 'zod'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Pool } from 'pg'
import { createPostgresAgentPendingQueue, mergePendingQueueItems, pendingQueueItemSchema, QueueSessionNotFound as AgentPendingQueueSessionNotFoundError, QueueConflict as AgentPendingQueueConflictError } from '@gugu/core/agent-sessions'
export { mergePendingQueueItems, AgentPendingQueueSessionNotFoundError, AgentPendingQueueConflictError }

const patchBody = z.object({
  session_id: z.number().int().positive(),
  items: z.array(pendingQueueItemSchema).max(200).default([]),
  remove_keys: z.array(z.number().int()).max(200).default([]),
}).strict()
const replaceBody = z.object({ items: z.array(pendingQueueItemSchema).max(200) }).strict()

const integerFields = new Set(['session_id', 'key', 'id', 'remove_keys', 'size', 'size_bytes', 'img_width', 'img_height'])
const floatFields = new Set(['duration'])
const booleanFields = new Set(['qq_face', 'quoted', 'upload'])

function coercePydanticJsonValues(value: unknown, field = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => coercePydanticJsonValues(item, field))
  if (!value || typeof value !== 'object') {
    if ((integerFields.has(field) || floatFields.has(field)) && typeof value === 'string' && value.trim()) {
      const numeric = Number(value)
      if (Number.isFinite(numeric) && (!integerFields.has(field) || Number.isInteger(numeric))) return numeric
    }
    if (integerFields.has(field) && typeof value === 'boolean') return value ? 1 : 0
    if (floatFields.has(field) && typeof value === 'boolean') return value ? 1 : 0
    if (booleanFields.has(field)) {
      if (typeof value === 'number' && (value === 0 || value === 1)) return Boolean(value)
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase()
        if (['1', 'true', 't', 'yes', 'y', 'on'].includes(normalized)) return true
        if (['0', 'false', 'f', 'no', 'n', 'off'].includes(normalized)) return false
      }
    }
    return value
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, coercePydanticJsonValues(item, key)]))
}

function valueAtPath(value: unknown, path: PropertyKey[]): unknown {
  let current = value
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<PropertyKey, unknown>)[part]
  }
  return current
}

function pydanticLikeErrors(error: z.ZodError, input: unknown): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = []
  for (const rawIssue of error.issues) {
    const issue = rawIssue as unknown as Record<string, unknown>
    const path = Array.isArray(issue.path) ? issue.path as PropertyKey[] : []
    const original = valueAtPath(input, path)
    const code = issue.code
    if (code === 'unrecognized_keys') {
      for (const key of (issue.keys as string[] | undefined) ?? []) {
        output.push({ type: 'extra_forbidden', loc: ['body', ...path, key], msg: 'Extra inputs are not permitted', input: original && typeof original === 'object' ? (original as Record<string, unknown>)[key] : undefined })
      }
      continue
    }
    if (code === 'invalid_type') {
      const expected = issue.expected
      const type = expected === 'number' ? 'int_type'
        : expected === 'string' ? 'string_type'
          : expected === 'boolean' ? 'bool_type'
            : expected === 'array' ? 'list_type'
              : expected === 'object' ? 'model_type' : 'value_error'
      const msg = expected === 'number' ? 'Input should be a valid integer'
        : expected === 'string' ? 'Input should be a valid string'
          : expected === 'boolean' ? 'Input should be a valid boolean'
            : expected === 'array' ? 'Input should be a valid list'
              : expected === 'object' ? 'Input should be a valid dictionary or object' : 'Input should be valid'
      output.push({ type, loc: ['body', ...path], msg, input: original })
      continue
    }
    if (code === 'too_small' || code === 'too_big') {
      const minimum = code === 'too_small'
      const origin = issue.origin
      const bound = issue.minimum ?? issue.maximum
      const inclusive = issue.inclusive !== false
      let type = 'value_error', msg = 'Input is invalid', ctx: Record<string, unknown> | undefined
      if (origin === 'number') {
        const relation = minimum ? (inclusive ? 'greater_than_equal' : 'greater_than') : (inclusive ? 'less_than_equal' : 'less_than')
        type = relation
        const phrase = minimum ? (inclusive ? 'greater than or equal to' : 'greater than') : (inclusive ? 'less than or equal to' : 'less than')
        msg = `Input should be ${phrase} ${String(bound)}`
        ctx = { [minimum ? (inclusive ? 'ge' : 'gt') : (inclusive ? 'le' : 'lt')]: bound }
      } else if (origin === 'string' || origin === 'array') {
        type = origin === 'string' ? (minimum ? 'string_too_short' : 'string_too_long') : (minimum ? 'too_short' : 'too_long')
        msg = minimum ? `Input should have at least ${String(bound)} ${origin === 'string' ? 'character' : 'item'}${bound === 1 ? '' : 's'}`
          : `Input should have at most ${String(bound)} ${origin === 'string' ? 'character' : 'item'}${bound === 1 ? '' : 's'}`
        ctx = { [minimum ? 'min_length' : 'max_length']: bound }
      }
      output.push({ type, loc: ['body', ...path], msg, input: original, ...(ctx ? { ctx } : {}) })
      continue
    }
    output.push({ type: 'value_error', loc: ['body', ...path], msg: String(issue.message ?? 'Input is invalid'), input: original })
  }
  return output
}

export interface AgentPendingQueuePatchRouteOptions {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  patch(ownerId: string, queueId: string, sessionId: number, upsertItems: Array<Record<string, unknown>>, removeKeys: number[]): Promise<void>
  publishChanged(ownerId: string, sessionId: number, origin?: string): Promise<void>
}

export interface AgentPendingQueueReplaceRouteOptions {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  replaceDraft(ownerId: string, queueId: string, items: Array<Record<string, unknown>>): Promise<void>
}

export function registerAgentPendingQueueReplaceRoute(
  app: FastifyInstance,
  options: AgentPendingQueueReplaceRouteOptions,
): void {
  app.put<{ Params: { queue_id: string }; Body: unknown }>(
    '/api/v1/agent/pending-queues/:queue_id',
    { preHandler: options.requireUser },
    async (request, reply) => {
      const queueId = request.params.queue_id
      if (!queueId || queueId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(queueId))
        return reply.code(422).send({ detail: '队列标识无效' })
      if (queueId.startsWith('session-'))
        return reply.code(409).send({ detail: '会话队列必须使用增量更新' })
      const parsed = replaceBody.safeParse(coercePydanticJsonValues(request.body))
      if (!parsed.success) return reply.code(422).send({ detail: pydanticLikeErrors(parsed.error, request.body) })
      const ownerId = options.userIdFromRequest(request)
      await options.replaceDraft(ownerId, queueId, parsed.data.items)
      return { ok: true, count: parsed.data.items.length }
    },
  )
}

export function registerAgentPendingQueuePatchRoute(
  app: FastifyInstance,
  options: AgentPendingQueuePatchRouteOptions,
): void {
  app.patch<{ Params: { queue_id: string }; Body: unknown }>(
    '/api/v1/agent/pending-queues/:queue_id',
    { preHandler: options.requireUser },
    async (request, reply) => {
      const queueId = request.params.queue_id
      if (!queueId || queueId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(queueId))
        return reply.code(422).send({ detail: '队列标识无效' })
      const parsed = patchBody.safeParse(coercePydanticJsonValues(request.body))
      if (!parsed.success) return reply.code(422).send({ detail: pydanticLikeErrors(parsed.error, request.body) })
      const body = parsed.data
      const ownerId = options.userIdFromRequest(request)
      try {
        await options.patch(ownerId, queueId, body.session_id, body.items, body.remove_keys)
        if (body.items.length || body.remove_keys.length) {
          const origin = request.headers['x-client-id']
          await options.publishChanged(ownerId, body.session_id, typeof origin === 'string' ? origin : undefined)
        }
        return { ok: true, count: body.items.length }
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

export function createPostgresAgentPendingQueuePatch(pool: Pick<Pool, 'query' | 'connect'>) {
  return createPostgresAgentPendingQueue(pool, {}).patch
}

export function createPostgresAgentPendingQueueReplace(pool: Pick<Pool, 'query' | 'connect'>) {
  return createPostgresAgentPendingQueue(pool, {}).replaceDraft
}
