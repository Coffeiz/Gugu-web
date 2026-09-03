import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import Components from 'unplugin-vue-components/vite'
import AutoImport from 'unplugin-auto-import/vite'
import { ArcoResolver } from 'unplugin-vue-components/resolvers'

// 发版门版本号：优先 git 短哈希（只在真发版/换提交时变），无 git（如 zip 部署）回退构建时间戳（每次构建必变）
const APP_VER = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim() } catch { return String(Date.now()) }
})()

// 语义化发布版本（package.json version，如 1.0.4）与构建时间，供控制台横幅与 version.json
const APP_RELEASE = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version
const APP_BUILT_AT = new Date().toLocaleDateString('sv') // 本地日期 YYYY-MM-DD（toISOString 会按 UTC 差一天）

// Runtime 包版本：优先 npm 安装目录，联调 alias 时回退 sibling 仓库
const RUNTIME_VER = (() => {
  for (const p of [
    resolve(__dirname, 'node_modules/gugu-interaction-runtime/package.json'),
    resolve(__dirname, '../../gugu-interaction-runtime/package.json'),
  ]) {
    try { return JSON.parse(readFileSync(p, 'utf8')).version } catch { /* 下一个路径 */ }
  }
  return ''
})()

// 生成真实 /version.json（此前不存在，SPA fallback 会把请求兜成 index.html，线上无法探测版本）
const versionJsonPlugin = {
  name: 'gugu-version-json',
  // closeBundle：产物已写盘后再补 version.json（buildEnd 阶段 dist 还没落盘）
  closeBundle() {
    mkdirSync(resolve(__dirname, 'dist'), { recursive: true })
    writeFileSync(resolve(__dirname, 'dist/version.json'), versionPayload())
  },
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if ((req.url || '').split('?')[0] !== '/version.json') return next()
      res.setHeader('content-type', 'application/json')
      res.end(versionPayload())
    })
  },
}
function versionPayload() {
  return JSON.stringify({
    version: APP_RELEASE, commit: APP_VER, built: APP_BUILT_AT,
    runtime: RUNTIME_VER || null,
  })
}

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
const localRuntimeAliases = process.env.VITE_USE_LOCAL_RUNTIME === '1'
  ? [
      // Integration CI / 本地联调可显式使用 sibling Runtime；生产镜像默认走 npm 包。
      { find: 'gugu-interaction-runtime/vue', replacement: resolve(__dirname, '../../gugu-interaction-runtime/dist-lib/vue.js') },
      { find: 'gugu-interaction-runtime', replacement: resolve(__dirname, '../../gugu-interaction-runtime/dist-lib/index.js') },
    ]
  : []

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VER),
    __APP_RELEASE__: JSON.stringify(APP_RELEASE),
    __APP_BUILT_AT__: JSON.stringify(APP_BUILT_AT),
    __RUNTIME_VERSION__: JSON.stringify(RUNTIME_VER),
  },
  plugins: [
    vue(),
    adminEntry,
    versionJsonPlugin,
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
      ...localRuntimeAliases,
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
