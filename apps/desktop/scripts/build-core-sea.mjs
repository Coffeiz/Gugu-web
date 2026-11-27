import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

export async function buildCoreSea({ payload, temp, node }) {
  const exe = join(payload, 'gugu-core.exe')
  const main = join(temp, 'main.cjs')
  const config = join(temp, 'sea.json')
  const source = join(payload, 'host/dist/runtime/transport/stdio.js')
  const worker = join(payload, 'host/core-worker.mjs')
  const chart = join(payload, 'host/node_modules/@gugu/charts/src/worker.mjs')
  const image = join(payload, 'host/node_modules/@gugu/gateway/dist/runtime/media/image-worker.js')
  const silk = join(payload, 'host/node_modules/@gugu/gateway/dist/runtime/media/silk-worker.js')
  const bundled = await build({
    entryPoints: {
      'core-worker': join(payload, 'host/dist/runtime/worker.js'),
    },
    outdir: join(payload, 'host'),
    outExtension: { '.js': '.mjs' },
    bundle: true,
    splitting: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node26',
    metafile: true,
  })
  const outputs = Object.values(bundled.metafile.outputs)
  console.log(JSON.stringify({
    bundledInputs: Object.keys(bundled.metafile.inputs).length,
    outputFiles: outputs.length,
    bundleBytes: outputs.reduce((total, output) => total + output.bytes, 0),
  }))
  const sourceText = await readFile(source, 'utf8')
  const entryEnd = /process\.exitCode = await main\(\);\s*$/
  assert.match(sourceText, entryEnd)
  const embedded = await build({
    stdin: {
      contents: sourceText.replace(entryEnd, 'export { main };'),
      resolveDir: resolve(source, '..'),
      sourcefile: source,
    },
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'cjs',
    target: 'node26',
    define: { 'import.meta.url': 'coreEntryUrl' },
    write: false,
  })
  const embeddedEntry = embedded.outputFiles[0].text
  const embeddedCli = (await build({
    entryPoints: [fileURLToPath(new URL('../../../packages/cli/src/bin.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node26',
    write: false,
  })).outputFiles[0].text.replace(/^#![^\n]*\n/, '')

  const bundleGateway = async file => (await build({
    entryPoints: [fileURLToPath(new URL(file, import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node26',
    external: ['@node-rs/jieba', '@aws-sdk/client-s3'],
    define: { 'import.meta.url': 'gatewayEntryUrl' },
    write: false,
  })).outputFiles[0].text
  const embeddedGateway = await bundleGateway('../src/main/im/gateway/platforms/qq/connection-child.ts')
  const embeddedPlatforms = await bundleGateway('../src/main/im/gateway/process-child.ts')

  // 桥接模块只从磁盘加载固定的 ESM 入口及其原生依赖。
  await writeFile(join(payload, 'bridge.cjs'), `
  const { pathToFileURL } = require('node:url')
  exports.run = file => import(pathToFileURL(file).href)
  `)
  await writeFile(main, `
  const { createRequire } = require('node:module')
  const { dirname, join, resolve } = require('node:path')
  const [entry, chart, image, silk] = ${JSON.stringify([source, chart, image, silk].map(file => relative(payload, file)))}
    .map(file => join(dirname(process.execPath), file))
  const first = process.argv[2]
  if (first === '--gateway' && process.argv[3] === 'qq') {
    const gatewayEntryUrl = require('node:url').pathToFileURL(process.execPath).href
    const gatewayRequire = createRequire(entry)
    ;((require) => {
  ${embeddedGateway}
    })(gatewayRequire)
    return
  }
  if (first === '--gateway' && process.argv[3] === 'platforms') {
    const gatewayEntryUrl = require('node:url').pathToFileURL(process.execPath).href
    ;((require) => {
  ${embeddedPlatforms}
    })(createRequire(entry))
    return
  }
  if (first === '--cli') {
    process.argv.splice(2, 1)
    ;(() => {
  ${embeddedCli}
    })()
    return
  }
  const target = first === '--core' ? entry
    : first === '--image-worker' ? image
    : first === '--silk-worker' ? silk
    : first && resolve(first) === chart ? chart : undefined
  if (!target) throw new Error('未知的 Core 启动模式')
  if (target === image || target === silk) {
    const flags = process.execArgv
    if (!flags.includes('--max-old-space-size=64') ||
        (target === silk && !flags.includes('--wasm-max-mem-pages=2048')))
      throw new Error('媒体 Worker 缺少运行时限制')
  }
  process.argv.splice(1, 2, target)
  const load = createRequire(entry)
  const coreEntryUrl = require('node:url').pathToFileURL(entry).href
  async function run() {
    if (target !== entry) return load(join(dirname(process.execPath), 'bridge.cjs')).run(target)
    const core = { exports: {} }
    ;((module, require) => {
  ${embeddedEntry}
    })(core, load)
    process.exitCode = await core.exports.main()
  }
  run().catch(() => {
    process.stderr.write('Core 入口加载失败\\n')
    process.exitCode = 1
  })
  `)
  // 仅用于探针，验证 V8 参数能真实传递到媒体子进程。
  await writeFile(config, JSON.stringify({ main, output: exe, execArgvExtension: 'cli', disableExperimentalSEAWarning: true }))
  const built = spawnSync(node, ['--build-sea', config], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(built.status, 0, built.error?.message ?? built.stderr)
  return { executable: 'gugu-core.exe', workerEntry: relative(payload, worker).replaceAll(String.fromCharCode(92), '/') }
}
