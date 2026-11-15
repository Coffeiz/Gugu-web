import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { z } from 'zod'
import type { ByokMediaDimension } from '@gugu/core/byok/media-capability-probe'
import { createByokMediaCapabilityProbeRunner } from '../byok/media-capability-probe.js'

const bodySchema = z.object({
  provider: z.string(),
  api_key: z.string().default(''),
  base_url: z.string().default(''),
  model: z.string().default(''),
  api_format: z.string().default(''),
})
const dimensionSchema = z.object({ dim: z.enum(['image', 'video', 'audio']).default('image') })

export type AdminMediaProbePreview = ReturnType<typeof createAdminMediaProbePreview>
export interface AdminMediaProbePreviewInput {
  provider: string; api_key: string; base_url: string; model: string; api_format: string; dim: ByokMediaDimension
}

/** 复用正式受控 Provider transport；草稿只探测，不读写后台配置。 */
export function createAdminMediaProbePreview(environment: NodeJS.ProcessEnv) {
  const probe = createByokMediaCapabilityProbeRunner(environment)
  return async (input: AdminMediaProbePreviewInput) => ({ dim: input.dim, ...await probe({
    provider: input.provider, apiFormat: input.api_format, baseUrl: input.base_url,
    model: input.model, apiKey: input.api_key,
  }, input.dim) })
}

export function registerAdminMediaProbePreviewRoute(app: FastifyInstance, options: {
  requireAdmin: preHandlerHookHandler
  probe: (input: AdminMediaProbePreviewInput) => ReturnType<AdminMediaProbePreview>
}): void {
  app.post('/api/v1/admin/agent/llm-presets/probe-media-preview', { preHandler: options.requireAdmin }, async (request, reply) => {
    const body = bodySchema.safeParse(request.body)
    if (!body.success) return reply.code(422).send({ detail: '媒体探测参数无效' })
    const query = dimensionSchema.safeParse(request.query)
    if (!query.success) return reply.code(400).send({ detail: 'dim 仅支持 image/video/audio' })
    return options.probe({ ...body.data, dim: query.data.dim as ByokMediaDimension })
  })
}
