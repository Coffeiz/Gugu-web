import { get } from 'node:http'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue(), {
    name: 'loopscope-vite-env',
    configureServer(server) {
      if (process.env.VITE_LOOPSCOPE_LOCAL_DESKTOP === 'true') {
        server.middlewares.use('/gugu-api/dev/loopscope', (request, response) => {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1')
          const loopback = request.socket.remoteAddress === '127.0.0.1' || request.socket.remoteAddress === '::1'
          const allowed = /^\/(?:health|events|reflections|sessions(?:\/[^/]+\/runs)?|runs\/[^/]+(?:\/spans)?)$/u
          if (!loopback || request.method !== 'GET' || request.headers.host !== '127.0.0.1:4319'
            || request.headers['sec-fetch-site'] === 'cross-site' || !allowed.test(url.pathname)) {
            response.writeHead(404).end()
            return
          }
          const upstream = get({ hostname: '127.0.0.1', port: 4320, path: '/api' + url.pathname + url.search }, result => {
            response.writeHead(result.statusCode ?? 503, {
              'Content-Type': result.headers['content-type'] ?? 'application/json',
              'Cache-Control': 'no-store',
            })
            result.pipe(response)
          })
          upstream.on('error', () => {
            if (!response.headersSent) response.writeHead(503)
            response.end()
          })
          response.on('close', () => upstream.destroy())
        })
      }
      // Vite 的客户端导入应使用公开入口，避免依赖 pnpm 的绝对路径。
      server.middlewares.use(async (request, response, next) => {
        if (request.method !== 'GET' || request.url !== '/@vite/client') return next()
        try {
          const client = await server.transformRequest('/@vite/client')
          if (!client) return next()
          const code = client.code.replace(/^(import )"\/@fs\/[^"\n]+\/node_modules\/vite\/dist\/client\/env\.mjs";/m, '$1"/@vite/env";')
          response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
          response.end(code)
        } catch (error) { next(error) }
      })
    },
  }],
  server: {
    host: '127.0.0.1',
    port: 4319,
    proxy: {
      '/gugu-api': {
        target: process.env.GUGU_API_TARGET ?? 'http://127.0.0.1:9595',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/gugu-api/, '/api/v1'),
      },
    },
  },
})
