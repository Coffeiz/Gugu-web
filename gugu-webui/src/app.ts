import Fastify from 'fastify'

export interface WebUiOptions {
  appName: string
  isReady: () => Promise<boolean>
  onReadinessError?: () => void
}

export function createApp(options: WebUiOptions) {
  const app = Fastify({ logger: false })

  app.get('/health', async () => ({ status: 'ok', app: options.appName }))

  app.get('/health/ready', async (request, reply) => {
    try {
      if (await options.isReady()) return { status: 'ok' }
    } catch {
      options.onReadinessError?.()
    }
    return reply.code(503).send({ status: 'not_ready' })
  })

  return app
}
