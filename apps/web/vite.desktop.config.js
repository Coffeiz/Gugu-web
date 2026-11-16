import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import base from './vite.config.js'

export default defineConfig({
  ...base,
  base: './',
  plugins: [
    ...(base.plugins ?? []),
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
})
