import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 4319,
    proxy: {
      '/gugu-api': {
        target: process.env.GUGU_API_TARGET ?? 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/gugu-api/, '/api/v1'),
      },
    },
  },
})
