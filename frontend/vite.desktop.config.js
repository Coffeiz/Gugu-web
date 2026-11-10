import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import base from './vite.config.js'

export default defineConfig({
  ...base,
  build: {
    ...base.build,
    outDir: 'dist-desktop',
    rollupOptions: {
      ...base.build?.rollupOptions,
      input: { desktop: resolve(__dirname, 'desktop.html') },
    },
  },
})
