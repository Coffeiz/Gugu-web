import { z } from 'zod'
import { CoreError } from '@gugu/core'
import { UserSkillValidationError } from '@gugu/core/agent/skills/user-management'
import type { createUserSkillManager } from '@gugu/core/agent/skills/user-management'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

const createBody = z.object({
  name: z.string().min(1).max(120),
  description_short: z.string().min(1).max(100),
  description_long: z.string().max(500).nullable().default(null),
  category: z.string().max(32).default('personal'),
  related_tools: z.array(z.string()).max(32).default([]),
  body: z.string().min(1).max(20_000),
  enabled: z.boolean().default(true),
})

const patchBody = z.object({
  name: z.string().min(1).max(120).nullable().optional(),
  description_short: z.string().min(1).max(100).nullable().optional(),
  description_long: z.string().max(500).nullable().optional(),
  category: z.string().max(32).nullable().optional(),
  related_tools: z.array(z.string()).max(32).nullable().optional(),
  body: z.string().min(1).max(20_000).nullable().optional(),
  enabled: z.boolean().nullable().optional(),
})

type Manager = Pick<ReturnType<typeof createUserSkillManager>, 'create' | 'update'>

export interface UserSkillWriteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  manager: Manager
}

function sendError(reply: { code(status: number): { send(value: unknown): unknown } }, error: unknown) {
  if (error instanceof UserSkillValidationError) return reply.code(422).send({ detail: error.message })
  if (error instanceof CoreError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'invalid_request' ? 400 : error.code === 'conflict' ? 409 : 500
    return reply.code(status).send({ detail: error.message })
  }
  throw error
}

/** Fastify 只验证 DTO 并映射错误；owner、校验、事务和事件由 Core 管理器负责。 */
export function registerUserSkillWriteRoutes(app: FastifyInstance, options: UserSkillWriteOptions): void {
  app.post('/api/v1/skills', { preHandler: options.requireUser }, async (request, reply) => {
    const parsed = createBody.safeParse(request.body)
    if (!parsed.success) return reply.code(422).send({ detail: 'Skill 参数无效' })
    try {
      return reply.code(201).send(await options.manager.create(options.ownerIdFromRequest(request), {
        ...parsed.data, managed_by: 'user',
      }))
    } catch (error) { return sendError(reply, error) }
  })

  app.patch<{ Params: { skill_id: string } }>('/api/v1/skills/:skill_id', { preHandler: options.requireUser }, async (request, reply) => {
    const parsed = patchBody.safeParse(request.body)
    if (!parsed.success) return reply.code(422).send({ detail: 'Skill 参数无效' })
    try {
      return await options.manager.update(options.ownerIdFromRequest(request), request.params.skill_id, {
        ...parsed.data,
        managed_by: 'user',
      })
    } catch (error) { return sendError(reply, error) }
  })
}
