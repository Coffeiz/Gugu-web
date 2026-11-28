import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'

const SPA_FALLBACK_EXCLUDED_PREFIXES = ['/api', '/health', '/assets', '/admin/assets']

function excludesSpaFallback(path: string): boolean {
  return path === '/version.json'
    || SPA_FALLBACK_EXCLUDED_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
}

export function registerStaticFrontend(app: FastifyInstance, root: string): void {
  app.register(fastifyStatic, { root, prefix: '/' })
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?', 1)[0] ?? '/'
    const accept = request.headers.accept
    const acceptsHtml = typeof accept === 'string' && accept.includes('text/html')
    const isPageRequest = request.method === 'GET' || request.method === 'HEAD'

    if (!isPageRequest || !acceptsHtml || excludesSpaFallback(path)) {
      return reply.code(404).send({
        message: `Route ${request.method}:${request.url} not found`,
        error: 'Not Found',
        statusCode: 404,
      })
    }

    const entry = path === '/admin' || path.startsWith('/admin/')
      ? 'admin/index.html'
      : 'index.html'
    return reply.type('text/html; charset=utf-8')
      .header('cache-control', 'no-cache')
      .sendFile(entry, root)
  })
}
