import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { TerminalEventPage } from '@gugu/core/terminals/events'

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
