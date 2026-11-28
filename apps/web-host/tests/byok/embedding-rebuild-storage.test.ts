import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createUserMemoryVectorRebuilder } from '@gugu/core/byok/vector-rebuild'
import { createPostgresRuntime } from '@gugu/core/data'
import { createLocalUserMemoryVectorStore } from '../../src/modules/agent/memory/store.js'
import { createOwnerMemoryLock } from '../../src/shared/owner-memory-lock.js'

test('Core 向量重建经 owner 绑定 Local 文件适配器持久化新向量并清除旧缓存', { skip: process.platform !== 'linux' && '生产安全写入适配器要求 Linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-byok-vector-'))
  const owner = '00000000-0000-4000-8000-000000000102'
  const directory = path.join(root, owner, '.agent')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'pattern.json'), JSON.stringify([{ id: 'p1', text: '合成偏好' }]))
  await writeFile(path.join(directory, 'memory.md'), '长期合成记忆。')
  await writeFile(path.join(directory, 'pattern_vec.json'), JSON.stringify({ stale: { v: [9], t: 'old' } }))
  await writeFile(path.join(directory, 'memory_vec.json'), JSON.stringify({ stale: { v: [8], t: 'old' } }))
  const rebuildMemoryIndex = { calls: 0 }
  try {
    const rebuild = createUserMemoryVectorRebuilder({
      ...createLocalUserMemoryVectorStore(root),
      embed: async (_owner, text) => [text.length, 0.25],
      async rebuildMemoryIndex(ownerId) { assert.equal(ownerId, owner); rebuildMemoryIndex.calls += 1 },
    })
    await assert.doesNotReject(rebuild(owner, 'openai:synthetic-embedding:default'))
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'pattern_vec.json'), 'utf8')), {
      p1: { v: [4, 0.25], t: 'openai:synthetic-embedding:default' },
    })
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'memory_vec.json'), 'utf8')), {
      '1113c43e7042': { v: [7, 0.25], t: 'openai:synthetic-embedding:default' },
    })
    assert.equal(rebuildMemoryIndex.calls, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('当前 pattern 损坏时不恢复旧 facts 正文或向量', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-byok-pattern-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const owner = randomUUID()
  const directory = path.join(root, owner, '.agent')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'pattern.json'), '{')
  await writeFile(path.join(directory, 'facts.json'), JSON.stringify([{ id: 'old', text: '已废弃的事实' }]))
  await writeFile(path.join(directory, 'pattern_vec.json'), JSON.stringify({ old: { v: [1], t: 'old' } }))
  const rebuild = createUserMemoryVectorRebuilder({
    ...createLocalUserMemoryVectorStore(root),
    async embed() { assert.fail('旧 facts 不应参与重建') },
    async rebuildMemoryIndex() {},
  })
  assert.equal((await rebuild(owner, 'new')).failedUsers, 0)
  assert.equal(await readFile(path.join(directory, 'pattern.json'), 'utf8'), '{')
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'pattern_vec.json'), 'utf8')), {})
})

for (const kind of ['pattern', 'memory'] as const) {
  test(`embedding 期间更新 ${kind} 后，旧向量不能覆盖新缓存`, {
    skip: !url || process.platform !== 'linux',
    timeout: 10_000,
  }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-byok-stale-'))
    const core = await createPostgresRuntime({ url: url! })
    const owner = randomUUID()
    const directory = path.join(root, owner, '.agent')
    const source = path.join(directory, kind === 'pattern' ? 'pattern.json' : 'memory.md')
    const cache = path.join(directory, `${kind}_vec.json`)
    const format = (text: string) => kind === 'pattern' ? JSON.stringify([{ id: 'p1', text }]) : text
    const withSourceLock = createOwnerMemoryLock(core.db)
    const indexOwners: string[] = []
    const currentVectors = { p1: { v: [9], t: 'current' } }
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(source, format('旧档案'))
      await writeFile(cache, '{}')
      const rebuild = createUserMemoryVectorRebuilder({
        ...createLocalUserMemoryVectorStore(root),
        withSourceLock,
        async embed(ownerId, text) {
          assert.equal(ownerId, owner)
          assert.equal(text, '旧档案')
          await withSourceLock(owner, async () => {
            await writeFile(source, format('更新后的档案'))
            await writeFile(cache, JSON.stringify(currentVectors))
          })
          return [1]
        },
        async rebuildMemoryIndex(ownerId) { indexOwners.push(ownerId) },
      })
      assert.deepEqual(await rebuild(owner, 'old'), {
        patternVectors: 0, memoryVectors: 0, withPatterns: 0, failedUsers: 1, ragIndexFailed: false,
      })
      assert.equal(await readFile(source, 'utf8'), format('更新后的档案'))
      assert.deepEqual(JSON.parse(await readFile(cache, 'utf8')), currentVectors)
      assert.deepEqual(indexOwners, [owner])
    } finally {
      await core.close()
      await rm(root, { recursive: true, force: true })
    }
  })
}
