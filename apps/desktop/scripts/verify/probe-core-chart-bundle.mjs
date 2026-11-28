import { createHash } from 'node:crypto'
import { mkdtemp, rename, rm, rmdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bundleChartWorker, bundledChartPackages } from '../build/bundle-chart-worker.mjs'

const defaultRoot = fileURLToPath(new URL('../../resources/core-sidecar/', import.meta.url))
const root = resolve(process.argv[2] ?? defaultRoot)
const charts = join(root, 'host', 'node_modules', '@gugu', 'charts')
const source = join(charts, 'src', 'worker.mjs')
const temporary = await mkdtemp(join(charts, '.bundle-probe-'))
const bundle = join(temporary, 'worker.mjs')

try {
  const result = await bundleChartWorker(source, bundle)
  const { createChartRenderer } = await import(pathToFileURL(join(charts, 'src', 'render.mjs')).href)
  const samples = [
    { type: 'mermaid', source: 'graph TD; A-->B;' },
    { type: 'mermaid', source: 'zenuml\nAlice\nBob\nAlice->Bob: Hello' },
    { type: 'math', source: '\\frac{1}{2}' },
  ]
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  console.log(JSON.stringify({ bundledInputs: Object.keys(result.metafile.inputs).length, bundleBytes: (await stat(bundle)).size }))
  const originals = []
  for (const sample of samples) {
    const [png] = await createChartRenderer({ path: source })({ charts: [sample] })
    originals.push(png)
  }
  const moved = []
  try {
    if (process.argv.includes('--hide-chart-deps')) {
      for (const name of bundledChartPackages) {
        const from = join(root, 'host', 'node_modules', name)
        const to = join(temporary, name.replaceAll('/', '-'))
        await rename(from, to)
        moved.push([from, to])
      }
    }
    for (const [index, sample] of samples.entries()) {
      const expected = originals[index]
      const [actual] = await createChartRenderer({ path: bundle })({ charts: [sample] })
      const identical = Boolean(expected && actual && digest(actual) === digest(expected))
      console.log(JSON.stringify({
        type: sample.source.startsWith('zenuml') ? 'zenuml' : sample.type,
        originalBytes: expected?.length ?? null,
        bundledBytes: actual?.length ?? null,
        identical,
      }))
      if (!identical) process.exitCode = 1
    }
  } finally {
    for (const [from, to] of moved.reverse()) await rename(to, from)
  }
} finally {
  // 临时目录由本脚本创建，且位于图表包内，确保资源相对路径与原 Worker 一致。
  await rm(bundle, { force: true })
  await rmdir(temporary)
}
