import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { AttentionDefaults } from '@gugu/core/im/attention/defaults'

export interface AttentionDefaultsOptions {
  requireUser: preHandlerHookHandler
  read(): AttentionDefaults
}

export function registerAttentionDefaultsRoute(app: FastifyInstance, options: AttentionDefaultsOptions): void {
  app.get('/api/v1/dev/attention/defaults', { preHandler: options.requireUser }, () => options.read())
}
