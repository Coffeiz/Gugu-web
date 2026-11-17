import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { readAdminLlmPresets } from '@gugu/core/agent/config'
import { readConfigOverride } from '../../adapters/config-override-file.js'

export function createAdminLlmPresetReader(path: string) {
  return () => readAdminLlmPresets(readConfigOverride(path))
}

export interface AdminLlmPresetReadOptions {
  requireAdmin: preHandlerHookHandler
  read: ReturnType<typeof createAdminLlmPresetReader>
}

export function registerAdminLlmPresetReadRoute(app: FastifyInstance, options: AdminLlmPresetReadOptions): void {
  app.get('/api/v1/admin/agent/llm-presets', { preHandler: options.requireAdmin }, () => options.read())
}
