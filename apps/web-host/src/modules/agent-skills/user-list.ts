import type { createUserSkillLister } from '@gugu/core/agent/skills/user-list'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { pythonQueryBoolean } from '../../http/python-query.js'

export interface UserSkillListOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  list: ReturnType<typeof createUserSkillLister>
}

export function registerUserSkillListRoute(app: FastifyInstance, options: UserSkillListOptions): void {
  app.get('/api/v1/skills', { preHandler: options.requireUser }, async (request, reply) => {
    const raw = (request.query as Record<string, unknown>).include_tools
    let includeTools = true
    try { if (raw !== undefined) includeTools = pythonQueryBoolean(raw) }
    catch { return reply.code(422).send({ detail: '技能查询参数无效' }) }
    if (includeTools) return reply.code(503).send({ detail: '技能工具目录暂不可用' })
    const skills = await options.list(options.ownerIdFromRequest(request))
    return { skills, tools: [] }
  })
}
