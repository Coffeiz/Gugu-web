import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { createLlmPresetMediaProbe, LlmPresetMediaProbeError } from '@gugu/core/agent/config'
import type { LlmMediaDimension } from '@gugu/core/agent/config'
import { createAdminMediaProbePreview } from './media-probe-preview.js'
import type { AdminMediaProbePreviewInput } from './media-probe-preview.js'
import type { LlmStrategyMutator } from '@gugu/core/agent/config/llm-strategy'

export function createAdminLlmPresetMediaProbe(options: {
  environment?: NodeJS.ProcessEnv
  readDocument(): unknown | Promise<unknown>
  mutate: LlmStrategyMutator
  invalidate(): Promise<unknown>
  probe?(input: AdminMediaProbePreviewInput): ReturnType<ReturnType<typeof createAdminMediaProbePreview>>
}) {
  const runProbe = options.probe ?? createAdminMediaProbePreview(options.environment ?? {})
  return createLlmPresetMediaProbe({
    readDocument: options.readDocument,
    mutate: options.mutate,
    invalidate: options.invalidate,
    probe: (config, dim) => runProbe({
      provider: typeof config.provider === 'string' ? config.provider : 'openai',
      api_key: typeof config.api_key === 'string' ? config.api_key : '',
      base_url: typeof config.base_url === 'string' ? config.base_url : '',
      model: typeof config.model === 'string' ? config.model : '',
      api_format: typeof config.api_format === 'string' ? config.api_format : '',
      dim,
    } satisfies AdminMediaProbePreviewInput),
  })
}

export function registerAdminLlmPresetMediaProbeRoute(app: FastifyInstance, options: {
  requireAdmin: preHandlerHookHandler
  probe(id: string, dim?: LlmMediaDimension): Promise<unknown>
}): void {
  app.post<{ Params: { preset_id: string } }>('/api/v1/admin/agent/llm-presets/:preset_id/probe-media', {
    preHandler: options.requireAdmin,
  }, async (request, reply) => {
    const rawDim = (request.query as Record<string, unknown>).dim
    const dim = rawDim === undefined || rawDim === '' ? undefined
      : typeof rawDim === 'string' && ['image', 'video', 'audio'].includes(rawDim) ? rawDim as LlmMediaDimension : null
    if (dim === null) return reply.code(400).send({ detail: 'dim 仅支持 image/video/audio' })
    try { return await options.probe(request.params.preset_id, dim) }
    catch (error) {
      if (error instanceof LlmPresetMediaProbeError) return reply.code(error.status).send({ detail: error.message })
      throw error
    }
  })
}
