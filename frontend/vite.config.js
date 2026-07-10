import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { execSync } from 'node:child_process'
import Components from 'unplugin-vue-components/vite'
import AutoImport from 'unplugin-auto-import/vite'
import { ArcoResolver } from 'unplugin-vue-components/resolvers'

// 发版门版本号：优先 git 短哈希（只在真发版/换提交时变），无 git（如 zip 部署）回退构建时间戳（每次构建必变）
const APP_VER = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim() } catch { return String(Date.now()) }
})()

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(APP_VER) },
  plugins: [
    vue(),
    Components({
      resolvers: [ArcoResolver({ sideEffect: true })],
      dts: 'components.d.ts',   // 生成全局组件类型声明，供 vue-tsc / 编辑器识别（已 gitignore）
    }),
    AutoImport({
      imports: ['vue', 'vue-router', 'pinia'],
      resolvers: [ArcoResolver()],
      dts: 'auto-imports.d.ts', // 生成自动导入（ref/computed/watch…）类型声明（已 gitignore）
    }),
  ],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  build: {
    rollupOptions: {
      input: {
        main:  resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin/index.html'),
      },
      output: {
        // admin 打包产物放到 dist/admin/ 下
        entryFileNames: (chunk) =>
          chunk.name === 'admin' ? 'admin/assets/[name]-[hash].js' : 'assets/[name]-[hash].js',
        chunkFileNames: (chunk) =>
          chunk.name?.startsWith('admin') ? 'admin/assets/[name]-[hash].js' : 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    host: true,
    // 通过自定义域名/内网穿透访问 dev server 时，需把域名加入白名单，否则 Vite 拦截 Host 头
    allowedHosts: ['myhome.coffeiz.space'],
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  test: {
    // 纯逻辑单测（Vitest）。jsdom 环境：DOMPurify 等依赖 DOM 的工具需要 window。
    // 复用上方 resolve.alias（@ → src）。组件/E2E 后续再加（见 docs/security 报告 P1-a）。
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{js,ts}'],
  },
})
