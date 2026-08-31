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

const adminEntry = {
  name: 'admin-entry',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const url = (req.url || '').split('?')[0]
      const isAdminPage = url === '/admin' || (url.startsWith('/admin/') && !/\.[a-z0-9]+$/i.test(url))
      if (isAdminPage) req.url = '/admin/index.html'
      next()
    })
  },
}
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(APP_VER) },
  plugins: [
    vue(),
    adminEntry,
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
    alias: [
      { find: '@', replacement: resolve(__dirname, 'src') },
      // 临时验证本地 Runtime 的浮层测量修复；验证完成后移除，不进入正式依赖配置。
      { find: 'gugu-interaction-runtime/vue', replacement: resolve(__dirname, '../../gugu-interaction-runtime/dist-lib/vue.js') },
      { find: 'gugu-interaction-runtime', replacement: resolve(__dirname, '../../gugu-interaction-runtime/dist-lib/index.js') },
      // 统一到 Gugu-web 的 Vue，避免产生两份响应式运行时。
      { find: 'vue', replacement: resolve(__dirname, 'node_modules/vue/dist/vue.runtime.esm-bundler.js') },
    ],
    dedupe: ['vue'],
  },
  build: {
    // Lightning CSS 会把部分 backdrop-filter 标准属性错误折叠为仅带前缀声明，
    // 导致生产 Chrome 的多层玻璃材质退化为半透明。使用 esbuild 压缩 CSS，保留兼容声明。
    cssMinify: 'esbuild',
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
    // Dockerfile 等部署文件不属于前端模块，Mutagen 同步时不能触发 Vite HMR。
    watch: {
      ignored: ['**/Dockerfile'],
    },
    // 与 Admin dev server 保持一致，确保 @vite/client 始终拿到具体布尔值。
    forwardConsole: false,
    // 通过自定义域名/内网穿透访问 dev server 时，需把域名加入白名单，否则 Vite 拦截 Host 头
    allowedHosts: ['myhome.coffeiz.space'],
    proxy: {
      // 本地非容器开发默认代理到 localhost:8000；docker compose 里前后端是两个独立容器，
      // "localhost" 指向前端容器自己，不是后端，因此 docker-compose.yml 给 frontend 服务
      // 传了 VITE_API_PROXY_TARGET=http://backend:8000（Docker 内网 DNS 按服务名解析）。
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:8000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    // 纯逻辑单测（Vitest）。jsdom 环境：DOMPurify 等依赖 DOM 的工具需要 window。
    // 复用上方 resolve.alias（@ → src）。组件/E2E 后续再加（见 docs/security 报告 P1-a）。
    environment: 'jsdom',
    include: ['test/**/*.{test,spec}.{js,ts}', 'src/**/*.{test,spec}.{js,ts}'],
  },
})
