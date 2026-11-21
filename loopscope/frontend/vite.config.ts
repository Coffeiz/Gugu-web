import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue(), {
    name: 'loopscope-vite-env',
    configureServer(server) {
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
