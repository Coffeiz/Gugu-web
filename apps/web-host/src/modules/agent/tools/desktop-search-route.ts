import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { desktopDeepResearchInput } from '@gugu/core/agent/search-contracts'
import type { DesktopDeepResearchInput } from '@gugu/core/agent/search-contracts'
import { desktopSimilarImageInput, MAX_DESKTOP_SEARCH_IMAGE_BASE64 } from '@gugu/core/agent/search-contracts'
import type { DesktopSimilarImageInput } from '@gugu/core/agent/search-contracts'
import type { UserAuthOptions } from '../../auth/contracts.js'
import { registerProtectedDomain } from '../../../http/user.js'

export interface DesktopAgentDeepResearchOptions {
  available?(ownerId: string): Promise<boolean>
  run(ownerId: string, input: DesktopDeepResearchInput, signal: AbortSignal): Promise<unknown>
}

export interface DesktopAgentSimilarImageOptions {
  available?(ownerId: string): Promise<boolean>
  run(ownerId: string, input: DesktopSimilarImageInput, signal: AbortSignal): Promise<unknown>
}

function watchSearchDisconnect(request: FastifyRequest, reply: FastifyReply) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const onResponseClose = () => { if (!reply.raw.writableFinished) abort() }
  request.raw.once('aborted', abort)
  reply.raw.once('close', onResponseClose)
  if (request.raw.aborted || reply.raw.destroyed) abort()
  return {
    signal: controller.signal,
    dispose() {
      request.raw.off('aborted', abort)
      reply.raw.off('close', onResponseClose)
    },
  }
}

function registerRoute(app: FastifyInstance, options: DesktopAgentDeepResearchOptions & {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
}) {
  app.get('/api/v1/agent/desktop-search/deep-research', { preHandler: options.requireUser }, async request => ({
    available: await options.available?.(options.ownerIdFromRequest(request)) ?? false,
  }))
  app.post('/api/v1/agent/desktop-search/deep-research', { preHandler: options.requireUser }, async (request, reply) => {
    const parsed = desktopDeepResearchInput.safeParse(request.body)
    if (!parsed.success) return reply.code(422).send({ detail: '深度研究请求无效' })
    const connection = watchSearchDisconnect(request, reply)
    try {
      connection.signal.throwIfAborted()
      const result = await options.run(options.ownerIdFromRequest(request), parsed.data, connection.signal)
      if (connection.signal.aborted) return reply.code(499).send({ detail: '搜索请求已取消' })
      return result
    } catch {
      if (connection.signal.aborted) return reply.code(499).send({ detail: '搜索请求已取消' })
      return reply.code(503).send({ detail: '深度研究暂不可用，请稍后重试' })
    } finally {
      connection.dispose()
    }
  })
}

export function registerDesktopAgentDeepResearchRoute(
  app: FastifyInstance,
  auth: UserAuthOptions,
  options: DesktopAgentDeepResearchOptions,
) {
  registerProtectedDomain(app, auth, (routes, userFromRequest) => registerRoute(routes, {
    ...options,
    requireUser: async request => { void userFromRequest(request) },
    ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
  }))
}

export function registerDesktopAgentSimilarImageRoute(
  app: FastifyInstance,
  auth: UserAuthOptions,
  options: DesktopAgentSimilarImageOptions,
) {
  registerProtectedDomain(app, auth, (routes, userFromRequest) => {
    routes.get('/api/v1/agent/desktop-search/similar-image', {
      preHandler: async request => { void userFromRequest(request) },
    }, async request => ({
      available: await options.available?.(userFromRequest(request).requestContext.data.ownerId) ?? false,
    }))
    routes.post('/api/v1/agent/desktop-search/similar-image', {
      bodyLimit: MAX_DESKTOP_SEARCH_IMAGE_BASE64 + 4096,
      preHandler: async request => { void userFromRequest(request) },
    }, async (request, reply) => {
      const parsed = desktopSimilarImageInput.safeParse(request.body)
      if (!parsed.success) return reply.code(422).send({ detail: '相似图片搜索请求无效' })
      const connection = watchSearchDisconnect(request, reply)
      try {
        connection.signal.throwIfAborted()
        const ownerId = userFromRequest(request).requestContext.data.ownerId
        const result = await options.run(ownerId, parsed.data, connection.signal)
        if (connection.signal.aborted) return reply.code(499).send({ detail: '搜索请求已取消' })
        return result
      } catch {
        if (connection.signal.aborted) return reply.code(499).send({ detail: '搜索请求已取消' })
        return reply.code(503).send({ detail: '相似图片搜索暂不可用，请稍后重试' })
      } finally {
        connection.dispose()
      }
    })
  })
}
