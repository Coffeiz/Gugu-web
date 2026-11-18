import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { z } from 'zod'
import { cleanAgentStateLabelOverrides, projectAgentStateLabelCatalog } from '@gugu/core/agent-sessions'
import { DEFAULT_AGENT_STATE_LABELS } from '@gugu/core/agent-sessions'
import { readConfigOverride, mutateConfigOverride } from '../../adapters/config-override-file.js'
import { createPosixConfigFileLock } from '../../adapters/posix-config-lock.js'

const requestBody = z.object({ overrides: z.record(z.string(), z.string()).default({}) }).default({ overrides: {} })
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function createAgentStateLabelOperations(options: {
  path: string
  toolLabels: Readonly<Record<string, string>>
}) {
  const defaults = { ...DEFAULT_AGENT_STATE_LABELS, ...options.toolLabels }
  return {
    read() {
      const config = readConfigOverride(options.path)
      const state = object(config.state_labels) ? config.state_labels : {}
      const raw = object(state.overrides) ? state.overrides : {}
      return projectAgentStateLabelCatalog(DEFAULT_AGENT_STATE_LABELS, options.toolLabels, raw)
    },
    async update(input: Record<string, string>) {
      const overrides = cleanAgentStateLabelOverrides(input, defaults)
      await mutateConfigOverride(options.path, document => {
        document.state_labels = { overrides }
      }, createPosixConfigFileLock())
      return { ok: true as const, count: Object.keys(overrides).length }
    },
  }
}

export function registerAgentStateLabelRoutes(app: FastifyInstance, options: {
  requireAdmin: preHandlerHookHandler
  read(): ReturnType<ReturnType<typeof createAgentStateLabelOperations>['read']>
  update(overrides: Record<string, string>): Promise<{ ok: true; count: number }>
}): void {
  const route = (method: 'GET' | 'PUT', handler: Parameters<FastifyInstance['route']>[0]['handler']) => app.route({
    method, url: '/api/v1/admin/agent/state-labels', preHandler: options.requireAdmin, handler,
  })
  route('GET', async () => options.read())
  route('PUT', async (request, reply) => {
    const body = requestBody.safeParse(request.body)
    if (!body.success) return reply.code(422).send({ detail: '状态标签参数无效' })
    return options.update(body.data.overrides)
  })
}
