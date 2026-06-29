import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { execSync } from 'node:child_process'
import Components from 'unplugin-vue-components/vite'
import AutoImport from 'unplugin-auto-import/vite'

// 发版门版本号（admin dev server 用；生产构建走 vite.config.js）。同 vite.config.js 口径。
const APP_VER = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim() } catch { return String(Date.now()) }
})()

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
  define: { __APP_VERSION__: JSON.stringify(APP_VER) },
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
