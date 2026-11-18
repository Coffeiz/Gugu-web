import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

export class UnsupportedServiceError extends Error {
  readonly code = 'unsupported_service'

  constructor(name: string) {
    super(`不支持重启 ${name}`)
    this.name = 'UnsupportedServiceError'
  }
}

export interface ServiceRestartOperations {
  restart(name: string): Promise<{ ok: boolean; msg: string }>
}

export function createServiceRestarter(restartWorkers: () => Promise<boolean>): ServiceRestartOperations['restart'] {
  return async name => {
    if (name === 'gateway') return { ok: false, msg: '当前 Host 没有可重启的网关服务。' }
    if (name !== 'worker') throw new UnsupportedServiceError(name)
    try {
      return await restartWorkers()
        ? { ok: true, msg: 'Node 后台任务已重启。' }
        : { ok: false, msg: 'Node 后台任务当前不可重启。' }
    } catch {
      return { ok: false, msg: 'Node 后台任务重启失败。' }
    }
  }
}

export function registerServiceRestartRoute(
  app: FastifyInstance,
  options: ServiceRestartOperations & { requireAdmin: preHandlerHookHandler },
): void {
  app.post<{ Params: { name: string } }>(
    '/api/v1/admin/services/:name/restart',
    { preHandler: options.requireAdmin },
    async (request, reply) => {
      try { return await options.restart(request.params.name) }
      catch (error) {
        if (error instanceof UnsupportedServiceError)
          return reply.code(400).send({ detail: error.message })
        throw error
      }
    },
  )
}
