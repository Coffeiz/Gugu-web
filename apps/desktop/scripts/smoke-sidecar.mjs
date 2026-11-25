// 只使用新建临时数据库，证明脱离源码目录后不依赖系统 Node/Python 或开发依赖。
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootIndex = process.argv.indexOf('--root')
const root =
  rootIndex >= 0
    ? resolve(process.argv[rootIndex + 1])
    : resolve(fileURLToPath(new URL('../resources/core-sidecar/', import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const workerEntry = manifest.workerEntry ?? 'host/dist/runtime/worker.js'
const agentRuntimeModule = manifest.agentRuntimeModule
assert.equal(agentRuntimeModule, 'host/agent/runtime.mjs')
assert.equal(manifest.platform, process.platform)
assert.equal(manifest.arch, process.arch)
for (const [name, hash] of Object.entries(manifest.files)) {
  const path = resolve(root, name)
  assert.ok(path.startsWith(root + sep))
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), hash)
}
const directory = mkdtempSync(join(tmpdir(), 'gugu-sidecar-check-')),
  database = join(directory, 'core.db'),
  operation = randomUUID()
try {
  const isolated = join(directory, 'runtime')
  cpSync(root, isolated, { recursive: true, dereference: true })
  const run = (frames) => {
    const result = spawnSync(
      join(isolated, manifest.executable),
      [join(isolated, manifest.entry), '--database', database, '--protocol', '2',
        '--worker-entry', join(isolated, workerEntry),
        '--agent-runtime-module', join(isolated, agentRuntimeModule)],
      {
        cwd: directory,
        input: frames.map((item) => JSON.stringify(item) + '\n').join(''),
        encoding: 'utf8',
        timeout: 20_000,
        env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
      },
    )
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    return result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  }
  const created = run([
    {
      v: 2,
      id: 1,
      method: 'projects.create',
      params: { name: '独立制品计划' },
      operation_id: operation,
    },
  ])
  const reopened = run([
    {
      v: 2,
      id: 2,
      method: 'operations.get',
      params: { operation_id: operation },
    },
    { v: 2, id: 3, method: 'projects.list', params: {} },
  ])
  assert.equal(created[1].result.name, '独立制品计划')
  assert.deepEqual(reopened[1].result.result, created[1].result)
  assert.equal(reopened[2].result.length, 1)
  const connection = { platform: 'telegram', connectionId: 'a'.repeat(64) }
  const eventKey = 'b'.repeat(64)
  const admitted = run([{ v: 2, id: 4, method: 'im.inbox.admit',
    params: { ...connection, eventKey, sealedEvent: 'AQ==' } }])
  assert.equal(admitted[1].result, true)
  const loadInbox = () => run([{ v: 2, id: 5, method: 'im.inbox.prepare', params: connection }])[1].result
  const pending = loadInbox()
  assert.equal(pending.eventKey, eventKey)
  assert.equal(pending.sealedEvent, 'AQ==')
  assert.ok(pending.sessionId > 0)
  assert.match(pending.clientId, /^[a-f0-9]{64}$/)
  assert.deepEqual(loadInbox(), pending)
  const rendered = run([{ v: 2, id: 6, method: 'im.chart.render', accept_chunks: true,
    params: { type: 'mermaid', source: 'graph TD; A-->B;' } }])
  const response = rendered.find((frame) => frame.id === 6 && Object.hasOwn(frame, 'result'))
  const chunks = rendered.filter((frame) => frame.id === 6 && frame.event === 'response_chunk')
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.index, index)
    assert.equal(chunk.last, index === chunks.length - 1)
  }
  const chartResult = chunks.length
    ? JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data, 'base64'))).toString('utf8')).result
    : response?.result
  assert.equal(typeof chartResult, 'string')
  const png = Buffer.from(chartResult, 'base64')
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0)
  console.log(
    JSON.stringify({
      status: 'passed',
      platform: process.platform,
      arch: process.arch,
      checks: ['integrity', 'isolated-start', 'sqlite-write', 'restart-receipt', 'im-inbox-restart', 'im-chart-render'],
    }),
  )
} finally {
  assert.equal(dirname(directory), tmpdir())
  rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
}
