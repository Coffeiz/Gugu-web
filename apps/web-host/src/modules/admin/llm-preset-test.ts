import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { createLlmPresetTest, LlmPresetTestError } from '@gugu/core/agent/config'
import { ensureLlmPresets } from '@gugu/core/agent/config/llm-strategy'
import type { ProviderConfig, ProviderTransport } from '@gugu/core/providers'
import { createNodeProviderTransport } from '@gugu/core/providers/node'

type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown) => typeof value === 'string' ? value : ''

export interface AdminLlmPresetTestOptions {
  requireAdmin: preHandlerHookHandler
  readDocument(): unknown | Promise<unknown>
  environment: NodeJS.ProcessEnv
  createTransport?(config: ProviderConfig): ProviderTransport & { close?(): Promise<void> }
}

export function createAdminLlmPresetTest(options: Omit<AdminLlmPresetTestOptions, 'requireAdmin'>) {
  return createLlmPresetTest({
    async readPreset(id) {
      const raw = await options.readDocument()
      if (!record(raw)) throw new Error('invalid config document')
      const presets = ensureLlmPresets(structuredClone(raw))
      if (!Array.isArray(presets.items)) throw new Error('invalid preset list')
      const item = presets.items.find(value => record(value) && value.id === id)
      if (!record(item)) return null
      return { ...item, provider: text(item.provider) || 'openai', model: text(item.model), api_key: text(item.api_key),
        base_url: text(item.base_url), api_format: text(item.api_format) } as ProviderConfig
    },
    createTransport(config) {
      if (options.createTransport) return options.createTransport(config)
      const provider = config.provider?.trim().toLowerCase()
      return createNodeProviderTransport({
        allowLocal: provider === 'local' || provider === 'ollama',
        connectTimeoutMs: 10_000,
        environment: () => options.environment,
      })
    },
  })
}

export function registerAdminLlmPresetTestRoute(app: FastifyInstance, options: Pick<AdminLlmPresetTestOptions, 'requireAdmin'> & {
  test(id: string): ReturnType<ReturnType<typeof createLlmPresetTest>>
}): void {
  app.post<{ Params: { preset_id: string } }>('/api/v1/admin/agent/llm-presets/:preset_id/test', {
    preHandler: options.requireAdmin,
  }, async (request, reply) => {
    try {
      const result = await options.test(request.params.preset_id)
      return { ...result, probe: { status: result.status } }
    } catch (error) {
      if (error instanceof LlmPresetTestError)
        return reply.code(error.status).send({ detail: error.message })
      throw error
    }
  })
}
