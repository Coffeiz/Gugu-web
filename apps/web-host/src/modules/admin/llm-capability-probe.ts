import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { createLlmCapabilityProbe, LlmCapabilityProbeError } from '@gugu/core/agent/config'
import type { ProviderConfig, ProviderTransport } from '@gugu/core/providers'
import { createNodeProviderTransport } from '@gugu/core/providers/node'
import type { LlmStrategyMutator } from '@gugu/core/agent/config/llm-strategy'

export function createAdminLlmCapabilityProbe(options: {
  environment?: NodeJS.ProcessEnv
  readDocument(): unknown | Promise<unknown>
  mutate: LlmStrategyMutator
  invalidate(): Promise<unknown>
  createTransport?(config: ProviderConfig): ProviderTransport & { close?(): Promise<void> }
}) {
  return createLlmCapabilityProbe({
    readDocument: options.readDocument,
    mutate: options.mutate,
    invalidate: options.invalidate,
    createTransport(config) {
      if (options.createTransport) return options.createTransport(config)
      const provider = (config.provider ?? '').trim().toLowerCase()
      return createNodeProviderTransport({ allowLocal: provider === 'local' || provider === 'ollama', environment: () => options.environment ?? process.env })
    },
  })
}

export function registerAdminLlmCapabilityProbeRoute(app: FastifyInstance, options: {
  requireAdmin: preHandlerHookHandler
  probe(id: string): Promise<unknown>
}): void {
  app.post<{ Params: { preset_id: string } }>('/api/v1/admin/agent/llm-presets/:preset_id/capabilities', {
    preHandler: options.requireAdmin,
  }, async (request, reply) => {
    try { return await options.probe(request.params.preset_id) }
    catch (error) {
      if (error instanceof LlmCapabilityProbeError) return reply.code(error.status).send({ detail: error.message })
      throw error
    }
  })
}
