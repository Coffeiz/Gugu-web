import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { AttentionDefaults } from '@gugu/core/im/attention/defaults'
import { scoreAttentionSandbox } from '@gugu/core/im/attention/dev-sandbox'
import type { AttentionSandboxInput } from '@gugu/core/im/attention/dev-sandbox'
import { z } from 'zod'

export interface AttentionDefaultsOptions {
  requireUser: preHandlerHookHandler
  read(): AttentionDefaults
  score?(input: AttentionSandboxInput, nowMs: number): unknown
}

const scoreRequest = z.object({
  text: z.string().max(20_000),
  anchor_text: z.string().max(20_000).default(''),
  before_anchor: z.array(z.string()).max(5).default([]),
  after_anchor: z.array(z.string()).max(5).default([]),
  gap_seconds: z.number().int().min(0).max(600).default(30),
  member_active_age_seconds: z.number().int().min(0).max(600).nullable().optional(),
  aliases: z.array(z.string()).max(20).default(['咕咕']),
  mode: z.enum(['quiet', 'natural', 'active', 'autonomous']).default('natural'),
  snapshot_complete: z.boolean().default(true),
}).strict()

export function registerAttentionDefaultsRoute(app: FastifyInstance, options: AttentionDefaultsOptions): void {
  app.get('/api/v1/dev/attention/defaults', { preHandler: options.requireUser }, () => options.read())
  app.post('/api/v1/dev/attention/score', { preHandler: options.requireUser }, async (request, reply) => {
    const parsed = scoreRequest.safeParse(request.body)
    if (!parsed.success) return reply.code(422).send({ detail: '注意力评分参数无效' })
    return (options.score ?? scoreAttentionSandbox)(parsed.data, Date.now())
  })
}
