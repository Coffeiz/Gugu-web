import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { z } from 'zod'
import { createAgentUiLabels } from '@gugu/core/agent-sessions'

const greetingQuery = z.object({ locale: z.enum(['zh-CN', 'ja-JP', 'en-US']).default('zh-CN') }).passthrough()

export interface AgentMiscRoutesOptions {
  requireUser: preHandlerHookHandler
  commandMenu(): unknown[]
  defaultStateLabels: Record<string, string>
  stateLabelOverrides(): Record<string, string | undefined>
  ownerIdFromRequest?(request: FastifyRequest): string
  greeting?(ownerId: string, locale: 'zh-CN' | 'ja-JP' | 'en-US', signal: AbortSignal): Promise<{ text: string; enabled: boolean }>
}

export function registerAgentMiscRoutes(app: FastifyInstance, options: AgentMiscRoutesOptions): void {
  const uiLabels = createAgentUiLabels(options)
  app.get('/api/v1/agent/commands', { preHandler: options.requireUser }, async () => ({
    commands: options.commandMenu(),
  }))

  app.get('/api/v1/agent/ui-labels', { preHandler: options.requireUser }, async () => uiLabels())

  if (options.greeting && options.ownerIdFromRequest) {
    app.get('/api/v1/agent/greeting', { preHandler: options.requireUser }, async (request, reply) => {
      const query = greetingQuery.safeParse(request.query)
      if (!query.success) return reply.code(422).send({ detail: 'locale 必须是 zh-CN、ja-JP 或 en-US' })
      return options.greeting!(options.ownerIdFromRequest!(request), query.data.locale, new AbortController().signal)
    })
  }

}
