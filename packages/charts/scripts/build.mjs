import { spawnSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const sources = [
  'src/index.mjs',
  'src/diagram-source.mjs',
  'src/render.mjs',
  'src/raster-dimensions.mjs',
  'src/svg-style.mjs',
  'src/theme.mjs',
  'src/worker.mjs',
]
const files = [
  ...sources,
  'assets/NotoSansSC-VariableFont_wght.ttf',
  'assets/OFL.txt',
]

await Promise.all(files.map(file => access(new URL(file, root))))
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
for (const target of Object.values(manifest.exports).flatMap(value =>
  typeof value === 'string' ? [value] : Object.values(value).filter(item => typeof item === 'string'))) {
  await access(new URL(target, root))
}
for (const source of sources) {
  const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(source, root))], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `Chart package source check failed: ${source}`)
}
process.stdout.write('@gugu/charts package files ready\n')
