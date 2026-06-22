import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import Components from 'unplugin-vue-components/vite'
import AutoImport from 'unplugin-auto-import/vite'

function adminEntryPlugin() {
  return {
    name: 'admin-entry',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url.split('?')[0]
        const isViteInternal = url.startsWith('/@') || url.startsWith('/__')
        const isApiRequest   = url.startsWith('/api')
        const hasExtension   = /\.[a-z0-9]+$/i.test(url)
        if (!isViteInternal && !isApiRequest && !hasExtension) {
          req.url = '/admin/index.html'
        }
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [
    adminEntryPlugin(),
    vue(),
    Components({ dts: false }),
    AutoImport({
      imports: ['vue', 'vue-router', 'pinia'],
      dts: false,
    }),
  ],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  server: {
    port: 5174,
    host: true,
    open: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
