import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { serializeLiveMessage } from '@gugu/core/live-message'
import {
  RedisLiveSubscriptionError,
  type LiveSubscriptionFactory,
} from '../../adapters/redis-live-subscription.js'

export const LIVE_BROADCAST_CHANNEL = 'events:__broadcast__'
const resetFrame = ': live connection reset; client will reconnect\n\n'
const connectedFrame = ': connected\n\n'
const suspendedFrame = 'event: account_suspended\ndata: {"message":"账号暂时不可用"}\n\n'

export interface LiveStreamOperations {
  subscribe: LiveSubscriptionFactory
  isUserActive(ownerId: string, expectedSecurityVersion: number): Promise<boolean>
}

export interface LiveRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  securityVersionFromRequest(request: FastifyRequest): number
  operations: LiveStreamOperations
}

async function* streamEvents(
  ownerId: string,
  expectedSecurityVersion: number,
  options: LiveRouteOptions,
  abort: AbortController,
): AsyncGenerator<string> {
  let subscription: Awaited<ReturnType<LiveSubscriptionFactory>> | null = null
  const channels = [`events:${ownerId}`, LIVE_BROADCAST_CHANNEL] as const
  try {
    subscription = await options.operations.subscribe(channels)
    yield connectedFrame
    if (!await options.operations.isUserActive(ownerId, expectedSecurityVersion)) {
      yield suspendedFrame
      return
    }
    while (!abort.signal.aborted) {
      const message = await subscription.next(abort.signal)
      if (message === null) return
      if (!await options.operations.isUserActive(ownerId, expectedSecurityVersion)) {
        yield suspendedFrame
        return
      }
      // auth.state.changed 是唤醒控制消息，不向浏览器公开。
      const frame = serializeLiveMessage(message.data)
      if (frame) yield frame
    }
  } catch (error) {
    if (abort.signal.aborted) return
    if (error instanceof RedisLiveSubscriptionError) {
      yield resetFrame
      return
    }
    throw error
  } finally {
    try {
      await subscription?.close()
    } catch {
      // 断开客户端时释放订阅是 best-effort，不输出 Redis 错误正文。
    }
  }
}

export function registerLiveRoutes(app: FastifyInstance, options: LiveRouteOptions): void {
  app.get('/api/v1/live/stream', { preHandler: options.requireUser }, async (request, reply) => {
    const ownerId = options.ownerIdFromRequest(request)
    const expectedSecurityVersion = options.securityVersionFromRequest(request)
    const abort = new AbortController()
    const abortStream = () => abort.abort()
    reply.raw.once('close', abortStream)
    const stream = Readable.from(streamEvents(ownerId, expectedSecurityVersion, options, abort))
    stream.once('close', () => reply.raw.off('close', abortStream))
    return reply
      .type('text/event-stream; charset=utf-8')
      .header('Cache-Control', 'no-cache, no-transform')
      .header('Connection', 'keep-alive')
      .header('X-Accel-Buffering', 'no')
      .send(stream)
  })
}
