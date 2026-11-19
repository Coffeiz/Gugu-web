import { registerTerminalCommandRoutes } from './shell/command.js'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { requestContext, CoreError } from '@gugu/core'
import type { UserAuthOptions } from '../auth/contracts.js'
import type { WebUiOptions } from '../../http/options.js'
import { registerProtectedDomain } from '../../http/user.js'
import { z } from 'zod'
import type { TerminalListItem, TerminalListResult } from '@gugu/core/terminals/list'
import { writeRequestMetadata } from '../../http/request.js'
import { Readable } from 'node:stream'
import type { TerminalEventPage } from '@gugu/core/terminals/events'

export function registerTerminalRoutes(app: FastifyInstance, auth: UserAuthOptions, options: WebUiOptions) {
  if (options.terminalDelete) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerTerminalDeleteRoute(routes, { ...options.terminalDelete!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  if (options.terminalCreate) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerTerminalCreateRoute(routes, {
      ...options.terminalCreate!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.terminalReopen) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerTerminalReopenRoute(routes, {
      ...options.terminalReopen!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.terminalLifecycle) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerTerminalLifecycleRoutes(routes, {
      ...options.terminalLifecycle!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.terminalMetrics) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerTerminalMetricsRoute(routes, {
      ...options.terminalMetrics!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.terminalList) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerTerminalListRoute(routes, {
      ...options.terminalList!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.terminalDetail) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerTerminalDetailRoute(routes, {
      ...options.terminalDetail!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.terminalRename) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerTerminalRenameRoute(routes, {
      ...options.terminalRename!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.terminalEvents) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerTerminalEventsRoute(routes, {
      ...options.terminalEvents!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.terminalCommand) {
    if (options.terminalCommand.close) app.addHook('onClose', async () => options.terminalCommand!.close!())
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerTerminalCommandRoutes(routes, {
      ...options.terminalCommand!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
}

const bodySchema = z.object({
  name: z.string().min(1).max(200).default('终端'),
  sessionId: z.number().int().positive().nullable().optional(),
  workspaceId: z.number().int().positive().nullable().optional(),
  mode: z.enum(['agent-events', 'interactive-pty']).default('interactive-pty'),
})

export interface TerminalCreateRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  create(ownerId: string, input: {
    name: string
    sessionId: number | null
    workspaceId: number | null
    mode: 'agent-events' | 'interactive-pty'
    origin: string | null
  }): Promise<TerminalListItem>
}

function sendCreateError(reply: { code(status: number): { send(body: unknown): unknown } }, error: unknown) {
  if (error instanceof CoreError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 422
    return reply.code(status).send({ detail: error.message })
  }
  const status = Number((error as { statusCode?: unknown })?.statusCode)
  if (Number.isInteger(status) && status >= 400 && status < 600)
    return reply.code(status).send({ detail: (error as Error).message })
  throw error
}

/** Create a terminal through the Core transaction and publish only after commit. */
export function registerTerminalCreateRoute(app: FastifyInstance, options: TerminalCreateRouteOptions): void {
  app.post('/api/v1/terminals', { preHandler: options.requireUser }, async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(422).send({ detail: '终端参数无效' })
    try {
      const origin = typeof request.headers['x-client-id'] === 'string' ? request.headers['x-client-id'] : null
      return reply.code(201).send(await options.create(options.ownerIdFromRequest(request), {
        ...parsed.data,
        sessionId: parsed.data.sessionId ?? null,
        workspaceId: parsed.data.workspaceId ?? null,
        origin,
      }))
    } catch (error) { return sendCreateError(reply, error) }
  })
}

export interface TerminalReopenRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  reopen(ownerId: string, terminalId: string, origin: string | null): Promise<TerminalListItem>
}

function sendError(reply: { code(status: number): { send(body: unknown): unknown } }, error: unknown) {
  if (error instanceof CoreError) return reply.code(error.code === 'not_found' ? 404 : 422).send({ detail: error.message })
  const status = Number((error as { statusCode?: unknown })?.statusCode)
  if (Number.isInteger(status) && status >= 400 && status < 600) return reply.code(status).send({ detail: (error as Error).message })
  throw error
}

/** Reopen a terminal through the owner-scoped Core transaction. */
export function registerTerminalReopenRoute(app: FastifyInstance, options: TerminalReopenRouteOptions): void {
  app.post<{ Params: { terminal_id: string } }>('/api/v1/terminals/:terminal_id/reopen', { preHandler: options.requireUser }, async (request, reply) => {
    try {
      const origin = typeof request.headers['x-client-id'] === 'string' ? request.headers['x-client-id'] : null
      return await options.reopen(options.ownerIdFromRequest(request), request.params.terminal_id, origin)
    } catch (error) { return sendError(reply, error) }
  })
}

export interface TerminalLifecycleRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  reset(ownerId: string, terminalId: string, origin: string | null): Promise<TerminalListItem>
  terminate(ownerId: string, terminalId: string, origin: string | null): Promise<TerminalListItem>
}

export function registerTerminalLifecycleRoutes(app: FastifyInstance, options: TerminalLifecycleRouteOptions): void {
  const routes = [
    ['reset', options.reset],
    ['terminate', options.terminate],
  ] as const
  for (const [action, perform] of routes) {
    app.post<{ Params: { terminal_id: string } }>(`/api/v1/terminals/:terminal_id/${action}`, { preHandler: options.requireUser }, async (request, reply) => {
      try {
        const origin = typeof request.headers['x-client-id'] === 'string' ? request.headers['x-client-id'] : null
        return await perform(options.ownerIdFromRequest(request), request.params.terminal_id, origin)
      } catch (error) { return sendError(reply, error) }
    })
  }
}

export interface TerminalDeleteOptions{
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 remove(ownerId:string,terminalId:string,origin:string|null):Promise<{deleted:boolean;terminalId:string}>
}

export function registerTerminalDeleteRoute(app:FastifyInstance,options:TerminalDeleteOptions):void{
 app.delete<{Params:{terminal_id:string}}>('/api/v1/terminals/:terminal_id',{preHandler:options.requireUser},request=>
  options.remove(options.ownerIdFromRequest(request),request.params.terminal_id,writeRequestMetadata(request).clientId))
}

export interface TerminalDetailOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  read(ownerId: string, terminalId: string): Promise<TerminalListItem>
}

export function registerTerminalDetailRoute(app: FastifyInstance, options: TerminalDetailOptions): void {
  app.get<{ Params: { terminal_id: string } }>('/api/v1/terminals/:terminal_id', { preHandler: options.requireUser }, request =>
    options.read(options.ownerIdFromRequest(request), request.params.terminal_id))
}

export interface TerminalEventsOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  authorize(ownerId: string, terminalId: string): Promise<void>
  readPage(ownerId: string, terminalId: string, after: number): Promise<TerminalEventPage | null>
  sleep?(milliseconds: number): Promise<void>
}

function cursorFromQuery(value: unknown): number {
  if (value === undefined) return 0
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw Object.assign(new Error('参数 after 必须是非负整数'), { statusCode: 422 })
  const cursor = Number(value)
  if (!Number.isSafeInteger(cursor)) throw Object.assign(new Error('参数 after 必须是非负整数'), { statusCode: 422 })
  return cursor
}

/** Authenticates before opening a bounded SSE replay/poll stream over persisted terminal events. */
export function registerTerminalEventsRoute(app: FastifyInstance, options: TerminalEventsOptions): void {
  app.get<{ Params: { terminal_id: string }; Querystring: { after?: unknown } }>(
    '/api/v1/terminals/:terminal_id/events', { preHandler: options.requireUser }, async (request, reply) => {
      const ownerId = options.ownerIdFromRequest(request)
      const terminalId = request.params.terminal_id
      const after = cursorFromQuery(request.query.after)
      await options.authorize(ownerId, terminalId)
      const wait = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
      async function* generate() {
        let cursor = after
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const page = await options.readPage(ownerId, terminalId, cursor)
          if (!page) break
          for (const event of page.events) {
            cursor = event.sequence
            yield `data: ${JSON.stringify({ event })}\n\n`
          }
          if (page.closed && cursor >= page.lastSequence) break
          await wait(500)
        }
        yield 'event: end\ndata: {}\n\n'
      }
      return reply
        .header('Cache-Control', 'no-cache')
        .header('X-Accel-Buffering', 'no')
        .type('text/event-stream; charset=utf-8')
        .send(Readable.from(generate()))
    },
  )
}

export interface TerminalListOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  read(ownerId: string): Promise<TerminalListResult>
}

/** Terminal DTO, owner and access policy are supplied by the authenticated Host adapter. */
export function registerTerminalListRoute(app: FastifyInstance, options: TerminalListOptions): void {
  app.get('/api/v1/terminals', { preHandler: options.requireUser }, request =>
    options.read(options.ownerIdFromRequest(request)))
}

export interface TerminalMetricsOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  read(ownerId: string): Promise<{ total: number; running: number; outputChars: number; retentionDays: number; outputRetentionChars: number }>
}

/** 持久化计数仍受与 Python 终端页面相同的 Shell 页面授权保护。 */
export function registerTerminalMetricsRoute(app: FastifyInstance, options: TerminalMetricsOptions): void {
  app.get('/api/v1/terminals/metrics', { preHandler: options.requireUser }, request =>
    options.read(options.ownerIdFromRequest(request)))
}

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
