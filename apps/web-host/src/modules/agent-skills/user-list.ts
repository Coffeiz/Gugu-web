import type { createUserSkillLister } from '@gugu/core/agent/skills/user-list'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { pythonQueryBoolean } from '../../http/python-query.js'

export interface UserSkillTool {name:string;description_short:string;category:string;enabled:boolean}

export interface UserSkillListOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  list: ReturnType<typeof createUserSkillLister>
  tools?(owner:string):Promise<readonly UserSkillTool[]>
}

export function registerUserSkillListRoute(app: FastifyInstance, options: UserSkillListOptions): void {
  app.get('/api/v1/skills', { preHandler: options.requireUser }, async (request, reply) => {
    const raw = (request.query as Record<string, unknown>).include_tools
    let includeTools = true
    try { if (raw !== undefined) includeTools = pythonQueryBoolean(raw) }
    catch { return reply.code(422).send({ detail: '技能查询参数无效' }) }
    const owner=options.ownerIdFromRequest(request)
    if (includeTools) {
      if (!options.tools) return reply.code(503).send({ detail: '技能工具目录暂不可用' })
      return { skills: await options.list(owner), tools: await options.tools(owner) }
    }
    const skills = await options.list(owner)
    return { skills, tools: [] }
  })
  app.get('/api/v1/skills/tools', { preHandler: options.requireUser }, async (request, reply) => {
    if (!options.tools) return reply.code(503).send({ detail: '技能工具目录暂不可用' })
    return { tools: await options.tools(options.ownerIdFromRequest(request)) }
  })
}
