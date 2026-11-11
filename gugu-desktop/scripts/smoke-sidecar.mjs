// 只使用新建临时数据库，证明脱离源码目录后不依赖系统 Node/Python 或开发依赖。
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootIndex = process.argv.indexOf('--root')
const root = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1]) : resolve(fileURLToPath(new URL('../src-tauri/resources/core-sidecar/', import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
assert.equal(manifest.platform, process.platform); assert.equal(manifest.arch, process.arch)
for (const [name, hash] of Object.entries(manifest.files)) {
  const path = resolve(root, name)
  assert.ok(path.startsWith(root + sep))
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), hash)
}
const directory = mkdtempSync(join(tmpdir(), 'gugu-sidecar-check-')), database = join(directory, 'core.db'), operation = randomUUID()
try {
  const run = (frames) => {
    const result = spawnSync(join(root, manifest.executable), [join(root, manifest.entry), '--database', database, '--protocol', '2'], { cwd: directory, input: frames.map(item => JSON.stringify(item) + '\n').join(''), encoding: 'utf8', timeout: 20_000, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } })
    assert.equal(result.status, 0); assert.equal(result.stderr, '')
    return result.stdout.trim().split('\n').map(line => JSON.parse(line))
  }
  const created = run([{ v: 2, id: 1, method: 'projects.create', params: { name: '独立制品计划' }, operation_id: operation }])
  const reopened = run([{ v: 2, id: 2, method: 'operations.get', params: { operation_id: operation } }, { v: 2, id: 3, method: 'projects.list', params: {} }])
  assert.equal(created[1].result.name, '独立制品计划'); assert.deepEqual(reopened[1].result.result, created[1].result); assert.equal(reopened[2].result.length, 1)
  console.log(JSON.stringify({ status: 'passed', platform: process.platform, arch: process.arch, checks: ['integrity', 'isolated-start', 'sqlite-write', 'restart-receipt'] }))
} finally {
  assert.equal(dirname(directory), tmpdir())
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
