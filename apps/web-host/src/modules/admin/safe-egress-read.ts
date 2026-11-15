import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { publicSafeEgressSettings, type SafeEgressReadSettings } from '@gugu/core/preferences/safe-egress'

export function registerSafeEgressReadRoute(app: FastifyInstance, options: {
  requireAdmin: preHandlerHookHandler
  readSettings(): SafeEgressReadSettings
}): void {
  app.get('/api/v1/admin/safe-egress', { preHandler: options.requireAdmin }, async () => publicSafeEgressSettings(options.readSettings()))
}
