import { build } from 'esbuild'
import { copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDesktopAgentRuntime } from './build-agent-runtime.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
for (const entry of ['main', 'preload']) {
  await build({
    entryPoints: [resolve(root, `src/${entry}/index.ts`)],
    outfile: resolve(root, `dist/${entry}/index.cjs`),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    ...(entry === 'main' ? {
      banner: { js: 'const guguMainModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
      define: { 'import.meta.url': 'guguMainModuleUrl' },
    } : {}),
    external: ['electron', 'electron-updater'],
    sourcemap: true,
  })
}
await copyFile(resolve(root, '../../packages/core/src/agent/subagent/searcher/prompt.md'), resolve(root, 'dist/main/prompt.md'))
await buildDesktopAgentRuntime()
