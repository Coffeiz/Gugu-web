import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { writeRequestMetadata } from '../../http/request.js'
import type { TerminalListItem } from '@gugu/core/terminals/list'

export interface TerminalRenameOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  rename(ownerId: string, terminalId: string, input: { name: string; origin: string | null }): Promise<TerminalListItem>
}

export function registerTerminalRenameRoute(app: FastifyInstance, options: TerminalRenameOptions): void {
  app.patch<{ Params: { terminal_id: string }; Body: unknown }>('/api/v1/terminals/:terminal_id', { preHandler: options.requireUser }, request => {
    const name = (request.body as { name?: unknown } | null)?.name
    if (typeof name !== 'string' || name.length < 1)
      throw Object.assign(new Error('请求参数无效'), { statusCode: 422 })
    return options.rename(options.ownerIdFromRequest(request), request.params.terminal_id, {
      name, origin: writeRequestMetadata(request).clientId,
    })
  })
}
