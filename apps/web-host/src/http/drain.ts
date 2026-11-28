import type { FastifyInstance } from 'fastify'

/** 正在处理的请求自然完成，结束后立即回收转为空闲的 HTTP 连接。 */
export function drainHttpConnections(app: FastifyInstance): void {
  let draining = false
  app.addHook('preClose', async () => { draining = true })
  app.addHook('onResponse', async () => {
    if (draining) setImmediate(() => app.server.closeIdleConnections())
  })
}
