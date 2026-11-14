import { build } from 'esbuild'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
for (const entry of ['main', 'preload']) {
  await build({
    entryPoints: [resolve(root, `src/${entry}/index.ts`)],
    outfile: resolve(root, `dist/${entry}/index.cjs`),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['electron', 'electron-updater'],
    sourcemap: true,
  })
}
