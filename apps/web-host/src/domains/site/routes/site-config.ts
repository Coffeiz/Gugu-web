import type { FastifyInstance } from 'fastify'
import type { PublicSiteConfig } from '../site-config.js'

export function registerSiteConfigRoute(app: FastifyInstance, config: PublicSiteConfig): void {
  app.get('/api/v1/site-config', async () => config)
}
