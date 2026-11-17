import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

export interface AgentCapabilityCatalog {
  readonly generation: number
  readonly diagnostics: readonly string[]
  readonly tools: readonly Record<string, unknown>[]
  readonly skills: readonly Record<string, unknown>[]
}

export function registerAgentCapabilityCatalogRoute(app: FastifyInstance, options: {
  requireAdmin: preHandlerHookHandler
  read(): Promise<AgentCapabilityCatalog>
}): void {
  app.get('/api/v1/admin/agent/capabilities', { preHandler: options.requireAdmin }, async () => options.read())
}
