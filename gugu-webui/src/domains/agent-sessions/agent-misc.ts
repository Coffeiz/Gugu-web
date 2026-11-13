import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

export interface AgentMiscRoutesOptions {
  requireUser: preHandlerHookHandler
  commandMenu(): unknown[]
  defaultStateLabels: Record<string, string>
  stateLabelOverrides: Record<string, string | undefined>
}

function splitCandidates(raw: string | undefined): string[] {
  return (raw ?? '').split(/[|\n]/).map((value) => value.trim()).filter(Boolean)
}

export function registerAgentMiscRoutes(app: FastifyInstance, options: AgentMiscRoutesOptions): void {
  app.get('/api/v1/agent/commands', { preHandler: options.requireUser }, async () => ({
    commands: options.commandMenu(),
  }))

  app.get('/api/v1/agent/ui-labels', { preHandler: options.requireUser }, async () => {
    const overrides = Object.fromEntries(Object.entries(options.stateLabelOverrides)
      .filter(([key, value]) => key.startsWith('_') && Boolean(value)))
    const labels = { ...options.defaultStateLabels, ...overrides }
    return {
      thinking: splitCandidates(labels._thinking),
      contextCompacting: splitCandidates(labels._context_compaction),
    }
  })
}
