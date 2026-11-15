import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { createAgentUiLabels } from '@gugu/core/agent-sessions'

export interface AgentMiscRoutesOptions {
  requireUser: preHandlerHookHandler
  commandMenu(): unknown[]
  defaultStateLabels: Record<string, string>
  stateLabelOverrides(): Record<string, string | undefined>
}

export function registerAgentMiscRoutes(app: FastifyInstance, options: AgentMiscRoutesOptions): void {
  const uiLabels = createAgentUiLabels(options)
  app.get('/api/v1/agent/commands', { preHandler: options.requireUser }, async () => ({
    commands: options.commandMenu(),
  }))

  app.get('/api/v1/agent/ui-labels', { preHandler: options.requireUser }, async () => uiLabels())

}
