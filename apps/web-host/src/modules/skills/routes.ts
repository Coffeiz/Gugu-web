import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { pythonQueryBoolean } from '../../http/python-query.js'
import { writeRequestMetadata } from '../../http/request.js'
import { z } from 'zod'
import { CoreError } from '@gugu/core'
import type { createClawHubPreview, createClawHubSearch, createClawHubTrending, SkillDocumentPatch } from '@gugu/core/skills'
import { UserSkillValidationError } from '@gugu/core/skills'
import type { SkillStorageSource } from '@gugu/core/skills'

export interface UserSkillTool {name:string;description_short:string;category:string;enabled:boolean}

export interface UserSkillListOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  list(ownerId: string): Promise<readonly unknown[]>
  tools?(owner:string):Promise<readonly UserSkillTool[]>
  previewClawHub?: ReturnType<typeof createClawHubPreview>
  searchClawHub?: ReturnType<typeof createClawHubSearch>
  trendingClawHub?: ReturnType<typeof createClawHubTrending>
  createFileSkill?(ownerId: string, fields: z.infer<typeof createBody>, contextId: string | null, signal: AbortSignal): Promise<{ id: string }>
  installClawHub?(ownerId: string, reference: string, contextId: string | null, signal: AbortSignal): Promise<{ id: string }>
  updateFileSkill?(ownerId: string, slug: string, digest: string, patch: SkillDocumentPatch, contextId: string | null, source: SkillStorageSource): Promise<{ id: string; content_digest: string }>
  deleteFileSkill?(ownerId: string, slug: string, digest: string, contextId: string | null, source: SkillStorageSource): Promise<{ id: string }>
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
  app.get('/api/v1/skills/clawhub/search', { preHandler: options.requireUser }, async (request, reply) => {
    const query = z.object({ q: z.string().trim().min(1).max(200) }).safeParse(request.query)
    if (!query.success) return reply.code(422).send({ detail: '技能搜索参数无效' })
    if (!options.searchClawHub) return reply.code(503).send({ detail: '技能搜索暂不可用' })
    return { skills: await options.searchClawHub(query.data.q, AbortSignal.timeout(15_000)) }
  })
  app.get('/api/v1/skills/clawhub/trending', { preHandler: options.requireUser }, async (_request, reply) => {
    if (!options.trendingClawHub) return reply.code(503).send({ detail: '热门技能暂不可用' })
    return { skills: await options.trendingClawHub(AbortSignal.timeout(15_000)) }
  })
  app.get('/api/v1/skills/clawhub/preview', { preHandler: options.requireUser }, async (request, reply) => {
    const query = z.strictObject({ reference: z.string().min(1).max(200) }).safeParse(request.query)
    if (!query.success) return reply.code(422).send({ detail: '技能预览参数无效' })
    if (!options.previewClawHub) return reply.code(503).send({ detail: '技能详情暂不可用' })
    try { return await options.previewClawHub(query.data.reference, AbortSignal.timeout(30_000)) }
    catch (error) { return sendError(reply, error) }
  })
  app.post('/api/v1/skills/clawhub/install', { preHandler: options.requireUser }, async (request, reply) => {
    const input = z.strictObject({ reference: z.string().min(1).max(200) }).safeParse(request.body)
    if (!input.success) return reply.code(422).send({ detail: '技能安装参数无效' })
    if (!options.installClawHub) return reply.code(503).send({ detail: '技能安装暂不可用' })
    try {
      return reply.code(201).send(await options.installClawHub(options.ownerIdFromRequest(request), input.data.reference,
        writeRequestMetadata(request, { limitHeaders: true }).undoContextId, AbortSignal.timeout(30_000)))
    } catch (error) { return sendError(reply, error) }
  })
  app.post('/api/v1/skills/files', { preHandler: options.requireUser }, async (request, reply) => {
    const input = createBody.safeParse(request.body)
    if (!input.success) return reply.code(422).send({ detail: '技能参数无效' })
    if (!options.createFileSkill) return reply.code(503).send({ detail: '技能新建暂不可用' })
    try { return reply.code(201).send(await options.createFileSkill(options.ownerIdFromRequest(request), input.data,
      writeRequestMetadata(request, { limitHeaders: true }).undoContextId, AbortSignal.timeout(30_000))) }
    catch (error) { return sendError(reply, error) }
  })
  app.patch<{ Params: { slug: string } }>('/api/v1/skills/files/:slug', { preHandler: options.requireUser }, async (request, reply) => {
    const input = z.strictObject({ source: z.enum(['user', 'clawhub']), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/u), patch: z.strictObject({
      name: z.string().optional(), description: z.string().optional(), body: z.string().optional(), enabled: z.boolean().optional(),
      descriptionLong: z.string().nullable().optional(), category: z.string().optional(), relatedTools: z.array(z.string()).optional(),
    }) }).safeParse(request.body)
    if (!input.success) return reply.code(422).send({ detail: '技能更新参数无效' })
    if (!options.updateFileSkill) return reply.code(503).send({ detail: '技能更新暂不可用' })
    try { return await options.updateFileSkill(options.ownerIdFromRequest(request), request.params.slug, input.data.expectedDigest,
      input.data.patch, writeRequestMetadata(request, { limitHeaders: true }).undoContextId, input.data.source) }
    catch (error) { return sendError(reply, error) }
  })
  app.post<{ Params: { slug: string } }>('/api/v1/skills/files/:slug/delete', { preHandler: options.requireUser }, async (request, reply) => {
    const input = z.strictObject({ source: z.enum(['user', 'clawhub']), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).safeParse(request.body)
    if (!input.success) return reply.code(422).send({ detail: '技能删除参数无效' })
    if (!options.deleteFileSkill) return reply.code(503).send({ detail: '技能删除暂不可用' })
    try { return await options.deleteFileSkill(options.ownerIdFromRequest(request), request.params.slug, input.data.expectedDigest,
      writeRequestMetadata(request, { limitHeaders: true }).undoContextId, input.data.source) }
    catch (error) { return sendError(reply, error) }
  })
  app.get('/api/v1/skills/tools', { preHandler: options.requireUser }, async (request, reply) => {
    if (!options.tools) return reply.code(503).send({ detail: '技能工具目录暂不可用' })
    return { tools: await options.tools(options.ownerIdFromRequest(request)) }
  })
}

const createBody = z.object({
  name: z.string().min(1).max(120),
  description_short: z.string().min(1).max(100),
  description_long: z.string().max(500).nullable().default(null),
  category: z.string().max(32).default('personal'),
  related_tools: z.array(z.string()).max(32).default([]),
  body: z.string().min(1).max(20_000),
  enabled: z.boolean().default(true),
})

function sendError(reply: { code(status: number): { send(value: unknown): unknown } }, error: unknown) {
  if (error instanceof UserSkillValidationError) return reply.code(422).send({ detail: error.message })
  if (error instanceof CoreError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'invalid_request' ? 400 : error.code === 'conflict' ? 409 : 500
    return reply.code(status).send({ detail: error.message })
  }
  throw error
}
