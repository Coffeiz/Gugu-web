import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { cp, mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { buildCoreSea } from './build-core-sea.mjs'

if (process.platform !== 'win32') throw new Error('此原型仅验证 Windows')
const root = resolve(process.argv[2] ?? 'apps/desktop/resources/core-sidecar')
const temp = await mkdtemp(join(tmpdir(), 'gugu-core-sea-'))
const payload = join(temp, 'payload')
const database = join(temp, 'probe.db')
const operation = randomUUID()

// 第一阶段合并 Core 入口的本地模块，保留依赖包与独立 Worker 的正常解析。
await cp(join(root, 'host'), join(payload, 'host'), { recursive: true, dereference: true })
const { workerEntry } = await buildCoreSea({ payload, temp, node: join(root, 'node.exe') })
const relocated = join(temp, 'relocated')
await rename(payload, relocated)
const runtime = join(relocated, 'gugu-core.exe')
const files = await readdir(relocated, { recursive: true })
assert.ok(!files.some(file => /(?:^|[\\/])node\.exe$/i.test(file)))

function run(requests) {
  const result = spawnSync(runtime, ['--core', '--database', database, '--protocol', '2',
    '--worker-entry', join(relocated, workerEntry),
    '--agent-runtime-module', join(relocated, 'host/agent/runtime.mjs')], {
    cwd: temp, input: requests.map(request => JSON.stringify({ v: 2, ...request }) + '\n').join(''),
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
  })
  assert.equal(result.status, 0, result.error?.message ?? (result.stderr || result.stdout))
  return result.stdout.trim().split('\n').map(line => JSON.parse(line))
}

console.log(JSON.stringify({ exe: runtime, bytes: (await stat(runtime)).size, standaloneNode: false }))
const created = run([{ id: 1, method: 'projects.create', params: { name: '独立 Core 验证' }, operation_id: operation }])
assert.equal(created.find(frame => frame.id === 1)?.result?.name, '独立 Core 验证')
const checks = run([
  { id: 2, method: 'projects.list', params: {} },
  { id: 3, method: 'im.chart.render', params: { type: 'mermaid', source: 'graph TD; A-->B;' } },
  { id: 4, method: 'im.chart.render', params: { type: 'mermaid', source: 'zenuml\nAlice\nBob\nAlice->Bob: Hello' } },
  { id: 5, method: 'im.chart.render', params: { type: 'math', source: '\\frac{1}{2}' } },
])
assert.equal(checks.find(frame => frame.id === 2)?.result?.[0]?.name, '独立 Core 验证')
for (const id of [3, 4, 5]) {
  const frame = checks.find(item => item.id === id)
  assert.ok(frame?.result?.startsWith('iVBOR'), JSON.stringify(frame?.error))
}
console.log(JSON.stringify({ checks: ['sqlite-write', 'sqlite-restart', 'mermaid', 'zenuml', 'math'] }))

const png = Buffer.from(checks.find(frame => frame.id === 3).result, 'base64')
const imageOptions = JSON.stringify({ original: true, maxPixels: 64_000_000, maxOutputBytes: 8 * 1024 * 1024 })
const mediaOptions = { cwd: temp, timeout: 30_000, windowsHide: true }
const imageResult = spawnSync(runtime, ['--node-options=--max-old-space-size=64', '--image-worker', imageOptions],
  { ...mediaOptions, input: png })
assert.equal(imageResult.status, 0, imageResult.error?.message ?? imageResult.stderr?.toString())
assert.equal(JSON.parse(imageResult.stdout.toString()).original, true)
const unrestricted = spawnSync(runtime, ['--image-worker', imageOptions], { ...mediaOptions, input: png })
assert.notEqual(unrestricted.status, 0)
const invalidSilk = spawnSync(runtime, ['--node-options=--wasm-max-mem-pages=2048 --max-old-space-size=64', '--silk-worker'],
  { ...mediaOptions, input: Buffer.from('invalid silk') })
assert.equal(invalidSilk.status, 1)
assert.equal(invalidSilk.stderr.length, 0)
console.log(JSON.stringify({ checks: ['image-decode', 'image-requires-runtime-limit', 'silk-invalid-input'] }))

const token = randomUUID().replaceAll('-', '')
const server = createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/api/v1/projects' || request.headers.authorization !== 'Bearer ' + token) {
    response.writeHead(401).end()
    return
  }
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([{ id: 1, name: 'CLI 验证' }]))
})
await new Promise((ready, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', ready)
})
try {
  const { stdout } = await promisify(execFile)(runtime, ['--cli', 'project', 'list', '--json'], {
    ...mediaOptions,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', GUGU_DESKTOP_CLI_PORT: String(server.address().port), GUGU_DESKTOP_CLI_TOKEN: token },
  })
  assert.deepEqual(JSON.parse(stdout).data, [{ id: 1, name: 'CLI 验证' }])
  console.log(JSON.stringify({ check: 'cli-project-list' }))
} finally {
  await new Promise(resolveClose => server.close(resolveClose))
}

if (process.argv[3]) {
  const fixture = await readFile(resolve(process.argv[3]))
  const flags = ['--wasm-max-mem-pages=2048', '--max-old-space-size=64']
  const options = { ...mediaOptions, input: fixture }
  const baseline = spawnSync(join(root, 'node.exe'), [...flags, join(relocated, 'host/node_modules/@gugu/gateway/dist/runtime/media/silk-worker.js')], options)
  const actual = spawnSync(runtime, [`--node-options=${flags.join(' ')}`, '--silk-worker'], options)
  assert.equal(baseline.status, 0, baseline.error?.message ?? baseline.stderr?.toString())
  assert.equal(actual.status, 0, actual.error?.message ?? actual.stderr?.toString())
  assert.ok(baseline.stdout.length > 0)
  assert.deepEqual(actual.stdout, baseline.stdout)
  console.log(JSON.stringify({ check: 'silk-decode-identical', inputBytes: fixture.length, pcmBytes: actual.stdout.length }))
}
