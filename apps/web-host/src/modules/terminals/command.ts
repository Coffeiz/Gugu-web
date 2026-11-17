import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { z } from 'zod'
import type { TerminalCommandInput } from '@gugu/core/terminals/command'
import type { TerminalEventItem } from '@gugu/core/terminals/events'
import type { TerminalListItem } from '@gugu/core/terminals/list'
import { writeRequestMetadata } from '../../http/request.js'

const body = z.object({
  command: z.string().min(1).max(12000), cwd: z.string().max(1000).default('.'),
  timeout: z.number().min(0.1).max(300).default(30), maxOutputChars: z.number().int().min(1).max(120000).default(12000),
  network: z.enum(['none', 'egress']).default('none'), confirm: z.boolean().default(false), confirmCode: z.string().nullable().optional(),
})

export interface TerminalCommandRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  start(owner: string, terminal: string, input: TerminalCommandInput, origin?: string): Promise<{ terminal: TerminalListItem; requestId: string; event: TerminalEventItem }>
  cancel(owner: string, terminal: string, requestId: string): Promise<{ cancelled: boolean; requestId?: string }>
}

export function registerTerminalCommandRoutes(app: FastifyInstance, options: TerminalCommandRouteOptions) {
  app.post<{ Params: { terminal_id: string }; Body: unknown }>('/api/v1/terminals/:terminal_id/input', { preHandler: options.requireUser }, request => {
    const parsed = body.safeParse(request.body)
    if (!parsed.success) throw Object.assign(new Error('请求参数无效'), { statusCode: 422 })
    const { confirm: _untrustedConfirm, confirmCode, ...input } = parsed.data
    return options.start(options.ownerIdFromRequest(request), request.params.terminal_id,
      { ...input, ...(confirmCode ? { confirmCode } : {}) }, writeRequestMetadata(request).clientId ?? undefined)
  })
  app.post<{ Params: { terminal_id: string; request_id: string } }>('/api/v1/terminals/:terminal_id/cancel/:request_id', { preHandler: options.requireUser }, request =>
    options.cancel(options.ownerIdFromRequest(request), request.params.terminal_id, request.params.request_id))
}
