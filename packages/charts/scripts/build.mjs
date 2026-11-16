import { access } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const files = [
  'src/index.mjs',
  'src/diagram-source.mjs',
  'src/render.mjs',
  'src/raster-dimensions.mjs',
  'src/svg-style.mjs',
  'src/theme.mjs',
  'src/worker.mjs',
  'assets/NotoSansSC-VariableFont_wght.ttf',
]

await Promise.all(files.map(file => access(new URL(file, root))))
process.stdout.write('@gugu/charts package files ready\n')
