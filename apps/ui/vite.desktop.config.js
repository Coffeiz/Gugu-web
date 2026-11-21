import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import base from './vite.config.js'
import { desktopCorePreview } from '../desktop/scripts/vite-core-preview.mjs'

// 本地共享模块随源码更新，避免浏览器继续加载旧的预构建导出。
const desktopSourceEntries = {
  '@gugu/core/contracts': 'core/src/contracts/index.ts',
  '@gugu/core/desktop': 'core/src/contracts/desktop.ts',
  '@gugu/core/agent/chat-sse': 'core/src/agent/chat-sse.ts',
  '@gugu/core/agent/commands/menu': 'core/src/agent/commands/menu.ts',
  '@gugu/core/mail/contracts': 'core/src/mail/contracts.ts',
  '@gugu/core/preferences/text-upload': 'core/src/preferences/text-upload.ts',
  '@gugu/database/version': 'database/src/version.ts',
}
const desktopSourceIds = Object.keys(desktopSourceEntries)
const desktopSourceAliases = Object.entries(desktopSourceEntries).map(([id, path]) => ({
  find: new RegExp(`^${id}$`),
  replacement: resolve(__dirname, '../../packages', path),
}))

export default defineConfig(({ command }) => ({
  ...base,
  base: './',
  cacheDir: 'node_modules/.vite-desktop',
  optimizeDeps: {
    ...base.optimizeDeps,
    include: (base.optimizeDeps?.include ?? []).filter(name => !desktopSourceIds.includes(name)),
    exclude: [...(base.optimizeDeps?.exclude ?? []), ...desktopSourceIds],
  },
  resolve: {
    ...base.resolve,
    alias: [
      ...(command === 'serve' ? desktopSourceAliases : []),
      ...(base.resolve?.alias ?? []),
    ],
    dedupe: [...(base.resolve?.dedupe ?? []), 'vue-router', 'vue-i18n', 'pinia', '@arco-design/web-vue'],
  },
  plugins: [
    ...(base.plugins ?? []),
    desktopCorePreview(resolve(__dirname, '../desktop')),
    {
      name: 'desktop-vite-preview-csp',
      transformIndexHtml(html) {
        if (!process.env.NODE_ENV || process.env.NODE_ENV !== 'development') return html
        return html.replace(
          /connect-src 'none'/,
          "connect-src 'self' ws://127.0.0.1:5176",
        )
      },
    },
  ],
  build: {
    ...base.build,
    outDir: 'dist-desktop',
    rollupOptions: {
      ...base.build?.rollupOptions,
      input: { desktop: resolve(__dirname, 'desktop.html') },
    },
  },
}))
